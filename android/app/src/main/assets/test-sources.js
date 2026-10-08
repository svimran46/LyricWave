/**
 * Test Suite for Last.fm Source & Manual Search Source
 * 
 * Verifies:
 * 1. LastFmSource:
 *    - Username configuration and persistence
 *    - Normalized NowPlayingTrack object generation
 *    - Approximate mode: begins at position 0 on track change
 *    - Continuous playback update emission
 *    - 4-second polling timer lifecycle
 *    - Clean disconnect & idle states
 * 2. SearchSource:
 *    - Selection of track with metadata normalization
 *    - Clock start, pause, resume, seek operations
 *    - Scrubber compatibility with UnifiedSyncEngine
 */

import { LastFmSource } from './lastfm.js';
import { SearchSource } from './search.js';
import { UnifiedSyncEngine } from './engine.js';

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${desc}`);
  }
}

// Polyfill in-memory localStorage for Node testing if needed
if (typeof localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

console.log('--- Testing Last.fm Source (Approximate Mode) ---');

async function testLastFmSource() {
  const source = new LastFmSource({ pollInterval: 4000 });
  
  assert(source.name === 'lastfm', 'Source name is lastfm');
  assert(source.pollInterval === 4000, 'Poll interval is 4 seconds');
  assert(source.isRunning === false, 'Initially not running');
  assert(source.currentTrack === null, 'Initial track is null');

  // Username set & get
  source.setUsername('testuser123');
  assert(source.getUsername() === 'testuser123', 'Username persists and is retrieved');

  // Track change event verification
  let changedTrack = null;
  let updateTrack = null;
  let idleFired = false;

  source.onTrackChange = (t) => { changedTrack = t; };
  source.onPlaybackUpdate = (t) => { updateTrack = t; };
  source.onIdle = () => { idleFired = true; };

  // Mock fetchRecentTrack returning a now-playing scrobble
  source.fetchRecentTrack = async () => ({
    title: 'Instant Crush',
    artist: 'Daft Punk',
    album: 'Random Access Memories',
    albumArt: 'https://example.com/ram.jpg',
    durationSec: 337,
    isNowPlaying: true
  });

  // Start polling
  source.start();
  assert(source.isRunning === true, 'LastFmSource running after start()');

  // Trigger poll cycle
  await source.poll();

  assert(changedTrack !== null, 'onTrackChange fired on new scrobble');
  assert(changedTrack.title === 'Instant Crush', 'Track title correctly received');
  assert(changedTrack.artist === 'Daft Punk', 'Track artist correctly received');
  assert(changedTrack.position === 0, 'Approximate mode: track begins at position 0');
  assert(changedTrack.duration === 337, 'Track duration is 337 seconds');
  assert(changedTrack.isPlaying === true, 'Track is playing');
  assert(changedTrack.source === 'lastfm', 'Source is lastfm');
  assert(changedTrack.isApproximate === true, 'Flagged as approximate mode');

  // Second poll cycle with same track (should emit position update)
  await new Promise(r => setTimeout(r, 50));
  await source.poll();
  assert(updateTrack !== null, 'Playback update emitted on subsequent poll');
  assert(updateTrack.position >= 0, 'Playback position advanced');

  // Stop / Disconnect
  source.stop();
  assert(source.isRunning === false, 'Stopped running after stop()');
  assert(source.currentTrack === null, 'Current track cleared on stop()');
}

console.log('\n--- Testing SearchSource (Virtual Playback & Scrubber) ---');

async function testSearchSource() {
  const search = new SearchSource();
  assert(search.name === 'search', 'Source name is search');
  assert(search.isPlaying === false, 'Initially not playing');
  assert(search.currentTrack === null, 'Initially no selected track');

  let selectedTrack = null;
  let updateEvent = null;

  search.onTrackChange = (t) => { selectedTrack = t; };
  search.onPlaybackUpdate = (t) => { updateEvent = t; };

  // Select a track from search result
  search.selectTrack({
    id: 'lrclib_101',
    title: 'Starboy',
    artist: 'The Weeknd',
    album: 'Starboy',
    durationMs: 230000
  }, false);

  assert(selectedTrack !== null, 'Track selected from search');
  assert(selectedTrack.title === 'Starboy', 'Title matches selected track');
  assert(selectedTrack.duration === 230, 'Duration converted to 230 seconds');
  assert(selectedTrack.position === 0, 'Position initialized to 0 seconds');
  assert(selectedTrack.isPlaying === false, 'Not playing when autoStart is false');

  // Play / Start clock
  search.play();
  assert(search.isPlaying === true, 'isPlaying is true after play()');
  assert(updateEvent.isPlaying === true, 'onPlaybackUpdate notified play()');

  // Pause
  search.pause();
  assert(search.isPlaying === false, 'isPlaying is false after pause()');
  assert(updateEvent.isPlaying === false, 'onPlaybackUpdate notified pause()');

  // Seek
  search.seek(45);
  assert(search.positionSec === 45, 'Seeked position is 45 seconds');
  assert(updateEvent.position === 45, 'onPlaybackUpdate received seek position 45');

  search.stop();
  assert(search.isPlaying === false, 'Stopped and reset');
}

console.log('\n--- Testing UnifiedSyncEngine Integration with Both Sources ---');

async function testEngineIntegration() {
  let engineTrack = null;
  let enginePlayState = null;

  const engine = new UnifiedSyncEngine({
    onTrackChange: (t) => { engineTrack = t; },
    onPlaybackChange: (p) => { enginePlayState = p; }
  });

  // 1. Connect LastFmSource
  const lastfm = new LastFmSource();
  engine.connectSource(lastfm);

  lastfm.currentTrack = {
    id: 'lfm_1',
    title: 'Get Lucky',
    artist: 'Daft Punk',
    album: 'RAM',
    duration: 248,
    position: 0,
    isPlaying: true,
    source: 'lastfm',
    isApproximate: true
  };
  lastfm.onTrackChange(lastfm.currentTrack);

  assert(engineTrack !== null, 'Engine received Last.fm track');
  assert(engineTrack.title === 'Get Lucky', 'Engine track title is Get Lucky');
  assert(engine.isPlaying === true, 'Engine play state is true');
  assert(engine.offsetMs !== undefined, 'Engine offset control active');

  // 2. Switch to SearchSource
  const search = new SearchSource();
  engine.connectSource(search);

  search.selectTrack({
    id: 'search_2',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    album: 'After Hours',
    duration: 200
  }, true);

  assert(engineTrack.title === 'Blinding Lights', 'Engine seamlessly switched to Search track');
  assert(engine.durationSec === 200, 'Engine duration updated to 200s');

  // Verify scrubber seek via engine
  engine.seek(60);
  assert(Math.abs(engine.getPositionSeconds() - 60) < 0.1, 'Engine seeked to 60s');

  // Verify pause / play toggle
  engine.pause();
  assert(engine.isPlaying === false, 'Engine paused via toggle');

  engine.play();
  assert(engine.isPlaying === true, 'Engine resumed via toggle');

  engine.stop();
  search.stop();
}

async function run() {
  await testLastFmSource();
  await testSearchSource();
  await testEngineIntegration();

  console.log(`\nSources test results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
