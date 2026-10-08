/**
 * Regression tests for the code-review fixes (October 2026).
 *
 * Each block pins down a bug that shipped in 1.0.0 so it can't quietly come back:
 *  1. Connecting the mic to the engine must not start a recording.
 *  2. Repeated connects must not stack onError wrappers.
 *  3. Seek units are explicit (seek = seconds, seekMs = ms).
 *  4. MicSource.stop() cancels auto re-listen and drops in-flight recognition results.
 *  5. Spotify token refresh survives network errors (no forced logout).
 *  6. Last.fm errors are reported once and polling backs off.
 *  7. Estimated durations are replaced by LRCLIB's real length.
 *  8. LRCLIB artist matching rejects empty / tiny names.
 *  9. SpotifySource ignores responses that arrive after stop().
 */

// ---- Minimal browser shims for Node ---------------------------------------
function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; }
  };
}
if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = makeStorage();
if (typeof globalThis.sessionStorage === 'undefined') globalThis.sessionStorage = makeStorage();

const realFetch = globalThis.fetch;

const { UnifiedSyncEngine } = await import('./engine.js');
const { MicSource } = await import('./mic.js');
const { LastFmSource } = await import('./lastfm.js');
const { SpotifySource } = await import('./spotify-source.js');
const { artistsMatch } = await import('./lyrics.js');
const auth = await import('./auth.js');

let passed = 0;
let failed = 0;
function assert(condition, desc) {
  if (condition) { passed++; console.log(`  ✓ ${desc}`); }
  else { failed++; console.error(`  ✗ FAIL: ${desc}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Mic is never started by connectSource ---------------------------------
console.log('--- 1. connectSource does not start the microphone ---');
{
  const engine = new UnifiedSyncEngine();
  const mic = new MicSource();
  let startCalls = 0;
  mic.start = async () => { startCalls++; };
  mic.currentTrack = { id: 'acr1', title: 'Song', artist: 'Artist', duration: 200, isPlaying: true };

  engine.connectSource(mic);
  assert(startCalls === 0, 'Default connectSource() does not call mic.start()');
  engine.connectSource(mic, { start: false, syncCurrent: false });
  assert(startCalls === 0, 'connectSource(mic, {start:false}) does not call mic.start()');

  // Ordinary sources are still started.
  let otherStarted = 0;
  engine.connectSource({ start() { otherStarted++; }, stop() {} });
  assert(otherStarted === 1, 'Non-mic sources are still started on connect');
  engine.stop();
}

// 2. onError wrappers don't stack ------------------------------------------
console.log('--- 2. onError is not stacked across reconnects ---');
{
  let engineErrors = 0;
  let appErrors = 0;
  const engine = new UnifiedSyncEngine({ onError: () => { engineErrors++; } });
  const src = { onError: () => { appErrors++; }, stop() {} };
  for (let i = 0; i < 5; i++) engine.connectSource(src);
  src.onError(new Error('boom'));
  assert(appErrors === 1, 'App-level source error handler fires exactly once');
  assert(engineErrors === 1, 'Engine error handler fires exactly once');
  engine.stop();
}

// 3. Seek units -------------------------------------------------------------
console.log('--- 3. Explicit seek units ---');
{
  const engine = new UnifiedSyncEngine();
  await engine.setTrack({ id: 't', title: 'T', artist: 'A', duration: 200, isPlaying: false, syncedLyrics: '[00:01.00]x' }, false);
  engine.seekMs(400);
  assert(Math.abs(engine.getPositionSeconds() - 0.4) < 0.01, 'seekMs(400) lands at 0.4s (was: jumped to end of song)');
  engine.seek(12);
  assert(Math.abs(engine.getPositionSeconds() - 12) < 0.01, 'seek(12) lands at 12s');
  engine.seekBy(5);
  assert(Math.abs(engine.getPositionSeconds() - 17) < 0.01, 'seekBy(5) moves forward 5 seconds');
  engine.seekBy(-100);
  assert(engine.getPositionSeconds() === 0, 'seekBy clamps at 0');
  engine.stop();
}

// 4. Mic stop() cancels relisten + in-flight result ------------------------
console.log('--- 4. MicSource.stop() cancels timers and in-flight results ---');
{
  const mic = new MicSource();
  mic.currentTrack = { id: 'x', title: 'X', artist: 'Y' };
  mic.autoRelistenIntervalMs = 20;
  mic.setAutoRelisten(true);
  let started = 0;
  mic.start = async () => { started++; };
  mic.stop();
  await sleep(60);
  assert(started === 0, 'Auto re-listen does not fire after stop()');
  assert(mic.autoRelistenTimer === null, 'Auto re-listen timer cleared by stop()');

  // In-flight recognition: result arrives after the user cancelled.
  const mic2 = new MicSource();
  let identified = 0;
  let errors = 0;
  mic2.onIdentified = () => { identified++; };
  mic2.onTrackChange = () => { identified++; };
  mic2.onError = () => { errors++; };
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
    setTimeout(() => resolve({
      ok: true,
      json: async () => ({ success: true, title: 'Late', artist: 'Result', offsetMs: 1000 })
    }), 40);
  });
  mic2.isCancelled = false;
  const pending = mic2.dispatchToBackend(new Blob(['x']), 'audio/webm');
  await sleep(5);
  mic2.stop();
  await pending;
  assert(identified === 0, 'Cancelled recognition result is ignored');
  assert(errors === 0, 'Cancelling does not surface a timeout/network error');
  globalThis.fetch = realFetch;
}

// 5. Spotify refresh survives a network error -------------------------------
console.log('--- 5. Spotify refresh keeps the session on network errors ---');
{
  localStorage.setItem('lyricwave_access_token', 'old-access');
  localStorage.setItem('lyricwave_refresh_token', 'refresh-123');
  localStorage.setItem('lyricwave_expires_at', '0'); // expired -> refresh needed
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  let threw = null;
  try { await auth.refreshAccessToken(); } catch (e) { threw = e; }
  assert(threw && threw.transient === true, 'Network failure is reported as transient');
  assert(localStorage.getItem('lyricwave_refresh_token') === 'refresh-123', 'Refresh token kept after network failure');

  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try { await auth.refreshAccessToken(); } catch {}
  assert(localStorage.getItem('lyricwave_refresh_token') === 'refresh-123', 'Refresh token kept after HTTP 503');

  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  try { await auth.refreshAccessToken(); } catch {}
  assert(localStorage.getItem('lyricwave_refresh_token') === null, 'invalid_grant (400) still logs out');
  globalThis.fetch = realFetch;
}

// 6. Last.fm error reporting + backoff ---------------------------------------
console.log('--- 6. Last.fm reports errors once and backs off ---');
{
  const lf = new LastFmSource({ pollInterval: 4000 });
  let errorCount = 0;
  lf.onError = () => { errorCount++; };
  lf.fetchRecentTrack = async () => { throw new Error('Last.fm request failed: 500'); };
  lf.username = 'someone';
  lf.isRunning = true;
  await lf.poll();
  clearTimeout(lf.timer);
  await lf.poll();
  clearTimeout(lf.timer);
  await lf.poll();
  assert(errorCount === 1, 'Repeated failures produce a single alert');
  assert(lf.consecutiveErrors === 3, 'Consecutive errors are counted for backoff');
  lf.isRunning = false;
  clearTimeout(lf.timer);
}

// 7. Estimated durations adopt LRCLIB length ---------------------------------
console.log('--- 7. Estimated durations are replaced by the real length ---');
{
  const engine = new UnifiedSyncEngine();
  let sourceDuration = null;
  engine.currentSource = { setDuration: (s) => { sourceDuration = s; } };
  engine.track = { id: 'c1', title: 'Chart', artist: 'A', duration: 30, durationEstimated: true };
  engine.durationSec = 30;
  engine.adoptLyricsDuration({ status: 'synced', durationSec: 214 });
  assert(engine.durationSec === 214, 'Engine duration updated from 30s preview length to 214s');
  assert(sourceDuration === 214, 'Source told about the real duration');

  engine.track = { id: 's1', title: 'Spotify', artist: 'A', duration: 200 };
  engine.durationSec = 200;
  engine.adoptLyricsDuration({ status: 'synced', durationSec: 214 });
  assert(engine.durationSec === 200, 'Known durations are left alone');
  engine.stop();
}

// 8. Artist matching ---------------------------------------------------------
console.log('--- 8. LRCLIB artist matching ---');
{
  assert(artistsMatch('Daft Punk', 'Daft Punk') === true, 'Exact match');
  assert(artistsMatch('Daft Punk', 'Daft Punk feat. Pharrell Williams') === true, 'Containment on word boundary');
  assert(artistsMatch('Daft Punk', '') === false, 'Empty candidate never matches (was: matched everything)');
  assert(artistsMatch('Ed', 'Fred again..') === false, 'Short names do not match by substring');
  assert(artistsMatch('Adele', 'Adelaide Orchestra') === false, 'Partial-word substring does not match');
}

// 9. SpotifySource ignores late responses -----------------------------------
console.log('--- 9. SpotifySource drops responses that arrive after stop() ---');
{
  localStorage.setItem('lyricwave_access_token', 'live-token');
  localStorage.setItem('lyricwave_refresh_token', 'r');
  localStorage.setItem('lyricwave_expires_at', String(Date.now() + 3600_000));
  const sp = new SpotifySource();
  let emitted = 0;
  sp.onTrackChange = () => { emitted++; };
  sp.onPlaybackUpdate = () => { emitted++; };
  globalThis.fetch = () => new Promise((resolve) => setTimeout(() => resolve({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({ is_playing: true, progress_ms: 1000, currently_playing_type: 'track', item: { id: 'sp1', name: 'Late', duration_ms: 200000, artists: [{ name: 'X' }], album: { name: 'A', images: [] } } })
  }), 30));
  sp.isRunning = true;
  const p = sp.fetchCurrentlyPlaying();
  sp.stop();
  await p;
  assert(emitted === 0, 'No track emitted after stop()');
  assert(sp.currentTrack === null, 'currentTrack cleared on stop()');
  globalThis.fetch = realFetch;
}

console.log(`\nRegression results: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
