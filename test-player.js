/**
 * Unit Test for PlayerTracker Core Logic
 */

import { PlayerTracker } from './player.js';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function runTests() {
  console.log('--- Testing PlayerTracker ---');

  // 1. Initial State
  const tracker = new PlayerTracker();
  assert(tracker.isRunning === false, 'Tracker is initially not running');
  assert(tracker.currentTrack === null, 'Initial track is null');
  assert(tracker.isPlaying === false, 'Initial play state is false');

  // 2. Process Track Playback Data
  let trackChanged = false;
  let stateChanged = false;
  tracker.onTrackChange = (t) => { trackChanged = true; };
  tracker.onStateChange = (s) => { stateChanged = true; };

  const mockTrackData = {
    is_playing: true,
    progress_ms: 15000,
    timestamp: Date.now(),
    currently_playing_type: 'track',
    item: {
      id: 'track123',
      name: 'Starboy',
      artists: [{ name: 'The Weeknd' }, { name: 'Daft Punk' }],
      album: { name: 'Starboy', images: [{ url: 'https://example.com/cover.jpg' }] },
      duration_ms: 230000
    }
  };

  tracker.processPlaybackData(mockTrackData, 100); // 100ms RTT -> 50ms latency
  assert(trackChanged === true, 'onTrackChange fired on new track');
  assert(stateChanged === true, 'onStateChange fired on new track');
  assert(tracker.currentTrack.title === 'Starboy', 'Track title correctly parsed');
  assert(tracker.currentTrack.artists === 'The Weeknd, Daft Punk', 'Artists correctly formatted');
  assert(tracker.durationMs === 230000, 'Duration correctly saved');
  assert(tracker.isPlaying === true, 'Play state is true');
  assert(tracker.anchorProgressMs === 15050, 'Latency compensation correctly applied (15000 + 50ms)');

  // 3. Local Clock Estimation
  // Simulate 500ms elapsed
  const estimated = tracker.getEstimatedPositionMs();
  assert(estimated >= 15050, 'Local clock estimates position >= anchor');

  // 4. Seek Detection
  const seekData = {
    ...mockTrackData,
    progress_ms: 60000 // jumped by 45 seconds
  };
  tracker.processPlaybackData(seekData, 100);
  assert(tracker.anchorProgressMs === 60050, 'Seek detected: anchor snapped to seek position');

  // 5. Pause State
  const pauseData = {
    ...mockTrackData,
    is_playing: false,
    progress_ms: 60050
  };
  tracker.processPlaybackData(pauseData, 50);
  assert(tracker.isPlaying === false, 'Playback correctly detected as paused');
  assert(tracker.getEstimatedPositionMs() === 60050, 'Paused position remains frozen');

  // 6. Ad Handling
  let adDetected = false;
  tracker.onTrackChange = (t) => {
    if (t.type === 'ad') adDetected = true;
  };
  const adData = {
    is_playing: true,
    progress_ms: 2000,
    currently_playing_type: 'ad',
    item: null
  };
  tracker.processPlaybackData(adData, 80);
  assert(adDetected === true, 'Ad detected and handled gracefully');
  assert(tracker.playbackType === 'ad', 'Playback type set to ad');

  // 7. Podcast / Episode Handling
  let podcastDetected = false;
  tracker.onTrackChange = (t) => {
    if (t.type === 'episode') podcastDetected = true;
  };
  const episodeData = {
    is_playing: true,
    progress_ms: 45000,
    currently_playing_type: 'episode',
    item: {
      id: 'ep999',
      name: 'Episode 42: Tech Talks',
      show: { name: 'The AI Show', publisher: 'Deep Tech' },
      images: [{ url: 'https://example.com/ep.jpg' }],
      duration_ms: 1800000
    }
  };
  tracker.processPlaybackData(episodeData, 60);
  assert(podcastDetected === true, 'Podcast episode detected and parsed');
  assert(tracker.currentTrack.artists === 'The AI Show', 'Show name mapped as artist');

  // 8. Idle / 204 No Content
  let idleFired = false;
  tracker.onIdle = () => { idleFired = true; };
  tracker.handleNothingPlaying();
  assert(idleFired === true, 'onIdle fired when playback stops');
  assert(tracker.currentTrack === null, 'Track reset to null on idle');

  console.log(`\nTests completed: ${testsPassed} passed, ${testsFailed} failed.`);
  if (testsFailed > 0) process.exit(1);
}

runTests();
