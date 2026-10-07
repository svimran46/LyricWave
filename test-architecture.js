/**
 * Unit Test for Source-Agnostic Architecture:
 * - NowPlaying Interface & Normalizer
 * - SpotifySource
 * - UnifiedSyncEngine
 */

import { normalizeNowPlaying } from './types.js';
import { SpotifySource } from './spotify-source.js';
import { UnifiedSyncEngine } from './engine.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function runTests() {
  console.log('--- Testing NowPlaying Interface & Normalizer ---');

  // 1. Normalization from seconds
  const itemSec = normalizeNowPlaying({
    id: 'track1',
    title: 'Starboy',
    artist: 'The Weeknd',
    album: 'Starboy',
    duration: 230,
    position: 15,
    isPlaying: true,
    source: 'spotify'
  });

  assert(itemSec.title === 'Starboy', 'Title preserved');
  assert(itemSec.artist === 'The Weeknd', 'Artist preserved');
  assert(itemSec.duration === 230, 'Duration in seconds preserved (230s)');
  assert(itemSec.position === 15, 'Position in seconds preserved (15s)');
  assert(itemSec.isPlaying === true, 'isPlaying is true');

  // 2. Normalization from milliseconds
  const itemMs = normalizeNowPlaying({
    id: 'track2',
    title: 'Blinding Lights',
    artists: 'The Weeknd',
    duration_ms: 200000,
    progress_ms: 50000,
    is_playing: false
  });

  assert(itemMs.duration === 200, 'Duration converted from ms to seconds (200s)');
  assert(itemMs.position === 50, 'Position converted from ms to seconds (50s)');
  assert(itemMs.isPlaying === false, 'isPlaying mapped from is_playing');

  console.log('\n--- Testing SpotifySource Module ---');
  const source = new SpotifySource();
  assert(source.isRunning === false, 'SpotifySource initially idle');

  let trackChanged = false;
  let playbackUpdated = false;
  source.onTrackChange = (t) => { trackChanged = true; };
  source.onPlaybackUpdate = (t) => { playbackUpdated = true; };

  const mockPayload = {
    is_playing: true,
    progress_ms: 10000,
    currently_playing_type: 'track',
    item: {
      id: 'sp_123',
      name: 'Levitating',
      artists: [{ name: 'Dua Lipa' }],
      album: { name: 'Future Nostalgia', images: [{ url: 'https://img.com/art.jpg' }] },
      duration_ms: 203000
    }
  };

  source.processPlaybackData(mockPayload, 60); // 60ms RTT -> 30ms latency
  assert(trackChanged === true, 'SpotifySource emitted onTrackChange');
  assert(playbackUpdated === true, 'SpotifySource emitted onPlaybackUpdate');
  assert(source.currentTrackId === 'sp_123', 'Track ID tracked');

  console.log('\n--- Testing UnifiedSyncEngine with Any Source ---');
  const engine = new UnifiedSyncEngine();

  // Engine connects to source
  engine.connectSource(source);
  assert(engine.track !== null, 'Engine loaded track from source');
  assert(engine.track.title === 'Levitating', 'Engine track title matches');
  assert(engine.isPlaying === true, 'Engine play state matches');
  assert(engine.durationSec === 203, 'Engine duration in seconds matches');

  // Clock interpolation test
  const initialPos = engine.getPositionSeconds();
  assert(initialPos >= 10, 'Position interpolated from anchor');

  // Seeking test
  engine.seek(60);
  assert(Math.abs(engine.getPositionSeconds() - 60) < 0.2, 'Engine seeked to 60s');
  assert(engine.durationMs === 203000, 'Engine exposes durationMs (203000ms)');

  // Resilience to seek(NaN)
  const posBeforeNaN = engine.getPositionSeconds();
  engine.seek(NaN);
  assert(!isNaN(engine.getPositionSeconds()), 'Engine position is not NaN after seek(NaN)');
  assert(Math.abs(engine.getPositionSeconds() - posBeforeNaN) < 0.1, 'Engine position remains intact after seek(NaN)');

  // Pause test
  engine.pause();
  assert(engine.isPlaying === false, 'Engine paused');
  const pausedPos = engine.getPositionSeconds();

  // Wait a small tick to ensure position is frozen
  await new Promise(r => setTimeout(r, 50));
  assert(engine.getPositionSeconds() === pausedPos, 'Engine clock frozen when paused');

  // Verify hasOffset, isApproximate, and confidence preservation in normalizer
  const withMeta = normalizeNowPlaying({
    title: 'Song With Offset',
    artist: 'Artist',
    hasOffset: false,
    isApproximate: true,
    confidence: 85,
    spotifyId: 'track_xyz'
  });
  assert(withMeta.hasOffset === false, 'hasOffset preserved in normalizeNowPlaying');
  assert(withMeta.isApproximate === true, 'isApproximate preserved in normalizeNowPlaying');
  assert(withMeta.confidence === 85, 'confidence preserved in normalizeNowPlaying');
  assert(withMeta.spotifyId === 'track_xyz', 'spotifyId preserved in normalizeNowPlaying');

  // Verify onError chaining in connectSource
  let sourceErrorFired = false;
  let engineErrorFired = false;
  const dummySource = {
    name: 'test_dummy',
    onError: (err) => { sourceErrorFired = true; },
    stop: () => {}
  };
  const testEngine = new UnifiedSyncEngine({
    onError: (err) => { engineErrorFired = true; }
  });
  testEngine.connectSource(dummySource);
  dummySource.onError(new Error('Test error'));
  assert(sourceErrorFired === true, 'Source-level onError handler was called');
  assert(engineErrorFired === true, 'Engine-level onError handler was called in chain');

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  engine.stop();
  testEngine.stop();
  source.stop();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
