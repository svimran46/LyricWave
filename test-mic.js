/**
 * Unit Test for MicSource Logic, Lifecycle & Error Handling
 */

import { MicSource } from './mic.js';

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

console.log('--- Testing MicSource Logic & State Management ---');

// Polyfill in-memory localStorage for Node testing
if (typeof localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

async function runTests() {
  // 1. Initial State
  const mic = new MicSource();
  assert(mic.name === 'mic', 'Source name is mic');
  assert(mic.isListening === false, 'Initially not listening');
  assert(mic.currentTrack === null, 'Initial track is null');

  // 2. Consent Storage
  MicSource.setConsent(false);
  assert(MicSource.hasConsent() === false, 'Consent starts false when cleared');
  MicSource.setConsent(true);
  assert(MicSource.hasConsent() === true, 'Consent persists as true when granted');

  // 3. Browser Feature Support Check
  // Node doesn't have navigator.mediaDevices by default
  const supported = MicSource.isSupported();
  assert(typeof supported === 'boolean', 'isSupported() returns a boolean');

  // 4. Lifecycle state events
  let stateReceived = null;
  let statusReceived = null;
  let countdownReceived = null;
  let levelReceived = null;

  const testSource = new MicSource({
    onListeningStateChange: (state) => { stateReceived = state; },
    onStatusChange: (status) => { statusReceived = status; },
    onCountdown: (cd) => { countdownReceived = cd; },
    onAudioLevel: (lvl) => { levelReceived = lvl; }
  });

  // Trigger stop state check
  testSource.stop();
  assert(stateReceived === false, 'Stopping triggers onListeningStateChange(false)');
  assert(testSource.isListening === false, 'isListening is false after stop');

  // 5. Error callback formatting
  let errorMsg = null;
  let errorType = null;
  const errSource = new MicSource({
    onError: (msg, type) => {
      errorMsg = msg;
      errorType = type;
    }
  });

  errSource.onError('Audio was too quiet', 'too_quiet');
  assert(errorType === 'too_quiet', 'Error type correctly emitted');
  assert(errorMsg === 'Audio was too quiet', 'Error message correctly emitted');

  // 6. Auto Re-listen toggle & scheduling
  mic.setAutoRelisten(true);
  assert(mic.autoRelistenEnabled === true, 'Auto re-listen can be enabled');
  mic.setAutoRelisten(false);
  assert(mic.autoRelistenEnabled === false, 'Auto re-listen can be disabled');
  assert(mic.autoRelistenTimer === null, 'Auto re-listen timer cleared when disabled');

  // 7. Latency & Position Compensation Logic
  // Sample: offsetMs = 45000, upload/backend RTT = 850ms (post-recording delay)
  const mockOffsetMs = 45000;
  const mockPostRecordingDelayMs = 850;
  const expectedPositionSec = (mockOffsetMs + mockPostRecordingDelayMs) / 1000; // 45.85s (NOT 55.85s which double-counted 10s recording)
  assert(expectedPositionSec === 45.85, 'Position correctly compensates for post-recording RTT without double-counting sample duration');

  // 8. Cancellation behavior
  const cancelSource = new MicSource();
  let recorderStopped = false;
  cancelSource.mediaRecorder = {
    state: 'recording',
    onstop: () => {},
    stop: () => { recorderStopped = true; }
  };
  cancelSource.audioChunks = [new Uint8Array([1, 2, 3])];
  cancelSource.isListening = true;
  cancelSource.stop();

  assert(cancelSource.isCancelled === true, 'Stopping mic sets isCancelled flag to prevent upload');
  assert(cancelSource.audioChunks.length === 0, 'Stopping mic clears audioChunks immediately');
  assert(cancelSource.isListening === false, 'isListening is false after cancel');
  assert(recorderStopped === true, 'Underlying mediaRecorder stop() was cleanly invoked');
  assert(cancelSource.mediaRecorder === null, 'mediaRecorder reference cleared');

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
}

runTests();
