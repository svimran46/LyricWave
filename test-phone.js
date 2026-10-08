/**
 * Tests for PhoneMediaSource (Android media-session source) with a mocked native bridge.
 */
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

const { PhoneMediaSource, cleanNowPlayingMetadata, appNameFor } = await import('./phone-source.js');
const { UnifiedSyncEngine } = await import('./engine.js');

let passed = 0;
let failed = 0;
function assert(condition, desc) {
  if (condition) { passed++; console.log(`  ✓ ${desc}`); }
  else { failed++; console.error(`  ✗ FAIL: ${desc}`); }
}

function mockBridge(initial) {
  const calls = [];
  const bridge = {
    access: true,
    snap: initial,
    hasMediaAccess() { return this.access; },
    openMediaAccessSettings() { calls.push(['settings']); },
    getNowPlaying() { return JSON.stringify({ ...this.snap, access: this.access }); },
    mediaControl(action, pos) { calls.push([action, pos]); }
  };
  return { bridge, calls };
}

console.log('--- Title cleanup ---');
{
  const yt = cleanNowPlayingMetadata({ title: 'Daft Punk - Get Lucky (Official Audio)', artist: 'DaftPunkVEVO', package: 'com.google.android.youtube' });
  assert(yt.title === 'Get Lucky' && yt.artist === 'Daft Punk', 'YouTube "Artist - Song (Official Audio)" split and cleaned');
  const topic = cleanNowPlayingMetadata({ title: 'Levitating', artist: 'Dua Lipa - Topic', package: 'com.google.android.apps.youtube.music' });
  assert(topic.title === 'Levitating' && topic.artist === 'Dua Lipa', '"- Topic" channel suffix removed');
  const sp = cleanNowPlayingMetadata({ title: 'Anti-Hero - Acoustic', artist: 'Taylor Swift', package: 'com.spotify.music' });
  assert(sp.title === 'Anti-Hero - Acoustic' && sp.artist === 'Taylor Swift', 'Proper music-app metadata is left alone');
  const browser = cleanNowPlayingMetadata({ title: 'Adele – Hello [Official Music Video] | 4K', artist: '', package: 'com.android.chrome' });
  assert(browser.title === 'Hello' && browser.artist === 'Adele', 'Browser title with en dash, brackets and pipe');
  assert(appNameFor('com.spotify.music') === 'Spotify' && appNameFor('x.y') === '', 'App names for known packages');
}

console.log('--- Source lifecycle ---');
{
  const { bridge } = mockBridge({ active: true, package: 'com.spotify.music', title: 'Blinding Lights', artist: 'The Weeknd', durationMs: 200040, positionMs: 42000, isPlaying: true });
  const src = new PhoneMediaSource({ bridge, pollIntervalMs: 60_000 });
  assert(PhoneMediaSource.isAvailable(bridge) === true, 'isAvailable() with a capable bridge');
  assert(PhoneMediaSource.isAvailable({}) === false, 'isAvailable() false without bridge methods');

  let changes = 0, updates = 0, idles = 0, lastTrack = null, lastStatus = null;
  src.onTrackChange = (t) => { changes++; lastTrack = t; };
  src.onPlaybackUpdate = (t) => { updates++; lastTrack = t; };
  src.onIdle = () => { idles++; };
  src.onStatus = (s) => { lastStatus = s; };

  src.start();
  assert(changes === 1 && updates === 1, 'First poll emits one track change and one update');
  assert(lastTrack.title === 'Blinding Lights' && Math.abs(lastTrack.position - 42) < 0.01, 'Exact position from media session');
  assert(lastTrack.duration > 200 && !lastTrack.durationEstimated, 'Real duration used');
  assert(lastStatus.appName === 'Spotify' && lastStatus.isPlaying === true, 'Status reports app name and playing');

  src.handleSnapshot({ ...bridge.snap, access: true, positionMs: 44000 });
  assert(changes === 1 && updates === 2, 'Same song: playback update only');

  src.handleSnapshot({ ...bridge.snap, access: true, isPlaying: false });
  assert(lastTrack.isPlaying === false, 'Pause in the music app is propagated');

  src.handleSnapshot({ access: true, active: false });
  assert(idles === 1, 'Nothing playing -> idle');

  src.handleSnapshot({ access: false, active: false });
  assert(lastStatus.access === false, 'Revoked access reported in status');
  src.stop();
}

console.log('--- Unknown position falls back to approximate ---');
{
  const { bridge } = mockBridge({ active: true, package: 'com.example.player', title: 'Song', artist: 'Band', durationMs: 0, positionMs: -1, isPlaying: true });
  const src = new PhoneMediaSource({ bridge, pollIntervalMs: 60_000 });
  let track = null;
  src.onTrackChange = (t) => { track = t; };
  src.onPlaybackUpdate = (t) => { track = t; };
  src.start();
  assert(track.isApproximate === true, 'Flagged approximate when the app reports no position');
  assert(track.durationEstimated === true, 'Duration flagged as estimated when unknown');
  assert(track.position === 0, 'Approximate mode starts at 0');
  src.stop();
}

console.log('--- Transport controls drive the music app ---');
{
  const { bridge, calls } = mockBridge({ active: true, package: 'com.spotify.music', title: 'T', artist: 'A', durationMs: 180000, positionMs: 1000, isPlaying: true });
  const engine = new UnifiedSyncEngine();
  const src = new PhoneMediaSource({ bridge, pollIntervalMs: 60_000 });
  engine.connectSource(src);
  await new Promise((r) => setTimeout(r, 20));
  engine.pause();
  engine.play();
  engine.seek(30);
  assert(calls.some(c => c[0] === 'pause'), 'engine.pause() pauses the music app');
  assert(calls.some(c => c[0] === 'play'), 'engine.play() resumes the music app');
  assert(calls.some(c => c[0] === 'seek' && c[1] === 30000), 'engine.seek(30) seeks the music app to 30000 ms');

  // Song end must not pause/restart the music app (it is about to play the next song).
  calls.length = 0;
  engine.isPlaying = true;
  engine.anchorPositionSec = engine.durationSec + 1;
  engine.anchorLocalTime = performance.now();
  engine.rafId = 1; // pretend the loop is running
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
  engine.loop();
  assert(!calls.some(c => c[0] === 'pause' || c[0] === 'seek'), 'Song end does not pause or seek the music app');
  engine.rafId = null;
  src.stop();
  engine.stop();
}

console.log(`\nPhone source results: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
