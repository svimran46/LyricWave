/**
 * Unit Test for AudioReactive (beat / vocal / energy source) and the reel's Sprint 2 additions
 */

import { AudioReactive, estimateTempo, computeLineTiming } from './audio-reactive.js';
import { ReelVisualizer } from './reel.js';

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

const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// Synthetic synced lyrics: `count` lines, `beatsPerLine` beats each, at `bpm`
function makeLines(bpm, beatsPerLine, count, startMs = 4000) {
  const interval = (60000 * beatsPerLine) / bpm;
  const lines = [];
  for (let i = 0; i < count; i++) lines.push({ timeMs: Math.round(startMs + i * interval), text: `la la la line number ${i}` });
  return lines;
}

// Controllable clock + a fake C1 bridge
function makeEnv({ supported = true, hasPermission = true, grantOnRequest = null, startOk = true } = {}) {
  const env = { t: 1000, calls: [] };
  env.now = () => env.t;
  env.bridge = {
    audioReactiveSupported: () => supported,
    hasAudioPermission: () => hasPermission,
    requestAudioPermission: () => {
      env.calls.push('request');
      if (grantOnRequest !== null) {
        setTimeout(() => { globalThis.window.__lyricwaveAudioPermission?.(grantOnRequest); }, 0);
      }
    },
    startAudioReactive: () => { env.calls.push('start'); return startOk; },
    stopAudioReactive: () => { env.calls.push('stop'); }
  };
  env.frame = (over = {}) => globalThis.window.__lyricwaveAudioFrame?.({
    t: env.t, rms: 0.6, bass: 0.7, mid: 0.4, vocal: 0.5, high: 0.2,
    beat: false, beatStrength: 0, bpm: 0, silent: false, ...over
  });
  return env;
}

console.log('--- Testing AudioReactive ---');

// ---------------------------------------------------------------- Node without window
{
  assert(typeof window === 'undefined', 'Running without a window object (Node)');
  const ar = new AudioReactive({ bridge: null });
  assert(ar.mode === 'off', 'Initial mode is off');
  let f = ar.getFrame(1000);
  assert(f.energy === 0 && f.beat === 0 && f.vocal === 0 && f.mode === 'off', "'off' mode returns zeros");
  const m = await ar.enable();
  assert(m === 'lyrics' && ar.mode === 'lyrics', 'No bridge/window -> falls back to lyrics mode');
  ar.setLyrics(makeLines(120, 4, 8));
  ar.setPlaying(true);
  f = ar.getFrame(4100);
  assert(f.mode === 'lyrics' && f.energy > 0, 'Lyrics mode produces energy without window');
  ar.disable();
}

// Polyfill window / matchMedia (same approach as test-reel.js)
if (typeof window === 'undefined') {
  globalThis.window = {
    innerWidth: 800,
    innerHeight: 400,
    devicePixelRatio: 1,
    addEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} })
  };
}

// ---------------------------------------------------------------- tempo estimation
{
  assert(near(estimateTempo(makeLines(120, 4, 12)), 120, 1), '120 bpm with 4-beat lines -> ~120');
  assert(near(estimateTempo(makeLines(120, 2, 12)), 120, 1), '120 bpm with 2-beat lines -> ~120');
  assert(near(estimateTempo(makeLines(120, 8, 12)), 120, 1), '120 bpm with 8-beat lines -> ~120');
  assert(near(estimateTempo(makeLines(90, 4, 12)), 90, 1), '90 bpm with 4-beat lines -> ~90');
  assert(near(estimateTempo(makeLines(140, 4, 12)), 140, 1), '140 bpm with 4-beat lines -> ~140');
  const t = estimateTempo(makeLines(75, 4, 12));
  assert(t >= 70 && t <= 180, 'Result is always folded into 70-180 bpm');

  // robustness: one long instrumental break and a couple of empty marker lines
  const lines = makeLines(120, 4, 12);
  lines.splice(6, 0, { timeMs: lines[5].timeMs + 1000, text: '' });
  for (let i = 7; i < lines.length; i++) lines[i] = { ...lines[i], timeMs: lines[i].timeMs + 9000 };
  assert(near(estimateTempo(lines), 120, 1), 'Median ignores breaks / empty marker lines');

  assert(estimateTempo([]) === 0, 'No lines -> 0');
  assert(estimateTempo([{ timeMs: 1000, text: 'only one' }]) === 0, 'Single line -> 0');
  assert(estimateTempo(null) === 0 && estimateTempo('x') === 0, 'Garbage input -> 0, no throw');
  assert(AudioReactive.estimateTempo === estimateTempo, 'Static AudioReactive.estimateTempo is exposed');

  const timing = computeLineTiming(10000, 5, 15000);
  assert(timing.durationMs === 5000 && timing.words === 5, 'computeLineTiming mirrors the reel word model');
  assert(computeLineTiming(0, 2, 0).durationMs === 2500, 'computeLineTiming last-line fallback is 2500ms minimum');
}

// ---------------------------------------------------------------- isNativeAvailable
{
  const env = makeEnv();
  assert(AudioReactive.isNativeAvailable(env.bridge) === true, 'isNativeAvailable true for full bridge');
  assert(AudioReactive.isNativeAvailable(null) === false, 'isNativeAvailable false for null');
  assert(AudioReactive.isNativeAvailable({}) === false, 'isNativeAvailable false for empty object');
  assert(AudioReactive.isNativeAvailable(makeEnv({ supported: false }).bridge) === false, 'isNativeAvailable false when unsupported');
  const throwing = { ...env.bridge, audioReactiveSupported: () => { throw new Error('boom'); } };
  assert(AudioReactive.isNativeAvailable(throwing) === false, 'isNativeAvailable swallows bridge exceptions');
}

// ---------------------------------------------------------------- fallback paths
{
  const modes = [];
  const ar = new AudioReactive({ bridge: undefined });
  ar.onModeChange = (m) => modes.push(m);
  const m = await ar.enable();
  assert(m === 'lyrics', 'Missing bridge -> enable() resolves to lyrics');
  assert(modes.join() === 'lyrics', 'onModeChange fired once with lyrics');
  await ar.enable();
  assert(modes.length === 1, 'onModeChange not re-fired when mode is unchanged');
  ar.disable();
  assert(ar.mode === 'off' && modes.join() === 'lyrics,off', 'disable() -> off (+ onModeChange)');
  ar.disable();
  assert(modes.length === 2, 'disable() twice is harmless');

  const env = makeEnv({ supported: false });
  const ar2 = new AudioReactive({ bridge: env.bridge, now: env.now });
  assert(await ar2.enable() === 'lyrics', 'Unsupported device -> lyrics');
  assert(!env.calls.includes('start'), 'Unsupported device never starts native');

  const env3 = makeEnv({ startOk: false });
  const ar3 = new AudioReactive({ bridge: env3.bridge, now: env3.now });
  assert(await ar3.enable() === 'lyrics', 'startAudioReactive() false -> lyrics');
  assert(globalThis.window.__lyricwaveAudioFrame === undefined, 'Frame handler removed after failed start');

  const broken = { audioReactiveSupported: () => true, hasAudioPermission: () => { throw new Error('x'); },
    requestAudioPermission: () => { throw new Error('x'); }, startAudioReactive: () => { throw new Error('x'); },
    stopAudioReactive: () => { throw new Error('x'); } };
  const ar4 = new AudioReactive({ bridge: broken, permissionTimeoutMs: 20 });
  let threw = false;
  let m4;
  try { m4 = await ar4.enable(); ar4.getFrame(0); ar4.disable(); } catch { threw = true; }
  assert(!threw && m4 === 'lyrics', 'Throwing bridge never throws out of the API');
}

// ---------------------------------------------------------------- permission flow
{
  // already granted
  const env = makeEnv({ hasPermission: true });
  const ar = new AudioReactive({ bridge: env.bridge, now: env.now });
  assert(await ar.enable() === 'audio', 'Permission already granted -> audio');
  assert(!env.calls.includes('request') && env.calls.includes('start'), 'No permission request when already granted');
  ar.disable();
  assert(env.calls.includes('stop'), 'disable() stops the native stream');

  // request -> granted via callback
  const envG = makeEnv({ hasPermission: false, grantOnRequest: true });
  const prevCalls = [];
  globalThis.window.__lyricwaveAudioPermission = (g) => prevCalls.push(g);
  const arG = new AudioReactive({ bridge: envG.bridge, now: envG.now });
  assert(await arG.enable() === 'audio', 'Permission granted via callback -> audio');
  assert(prevCalls.length === 1 && prevCalls[0] === true, 'Previous permission handler is chained');
  assert(typeof globalThis.window.__lyricwaveAudioPermission === 'function'
    && globalThis.window.__lyricwaveAudioPermission !== undefined, 'Permission handler restored after use');
  arG.disable();
  delete globalThis.window.__lyricwaveAudioPermission;

  // request -> denied
  const envD = makeEnv({ hasPermission: false, grantOnRequest: false });
  const arD = new AudioReactive({ bridge: envD.bridge, now: envD.now });
  assert(await arD.enable() === 'lyrics', 'Permission denied -> lyrics');
  assert(!envD.calls.includes('start'), 'Denied permission never starts native');
  assert(globalThis.window.__lyricwaveAudioPermission === undefined, 'Permission handler removed after denial');

  // requestPermission:false
  const envN = makeEnv({ hasPermission: false });
  const arN = new AudioReactive({ bridge: envN.bridge, now: envN.now });
  assert(await arN.enable({ requestPermission: false }) === 'lyrics' && !envN.calls.includes('request'),
    'requestPermission:false does not prompt');

  // request -> no answer -> timeout
  const envT = makeEnv({ hasPermission: false });
  const arT = new AudioReactive({ bridge: envT.bridge, now: envT.now, permissionTimeoutMs: 30 });
  const t0 = Date.now();
  assert(await arT.enable() === 'lyrics', 'Permission callback never arrives -> timeout -> lyrics');
  assert(Date.now() - t0 < 2000, 'Permission timeout is honoured');
  assert(globalThis.window.__lyricwaveAudioPermission === undefined, 'Permission handler removed after timeout');
}

// ---------------------------------------------------------------- audio mode: frames, smoothing, beat envelope
{
  const env = makeEnv();
  const seen = [];
  const prevFrame = (f) => seen.push(f);
  globalThis.window.__lyricwaveAudioFrame = prevFrame;
  const ar = new AudioReactive({ bridge: env.bridge, now: env.now });
  ar.setPlaying(true);
  assert(await ar.enable() === 'audio' && ar.mode === 'audio', 'Granted + started -> audio mode');
  assert(globalThis.window.__lyricwaveAudioFrame !== prevFrame, 'Frame handler installed');

  env.frame({ rms: 1, bass: 1, vocal: 1 });
  assert(seen.length === 1, 'Previous frame handler stays chained');

  // attack: rises quickly (~60ms time constant)
  let f = ar.getFrame(0);
  env.t += 16; env.frame({ rms: 1, bass: 1, vocal: 1 }); f = ar.getFrame(16);
  const e1 = f.energy;
  for (let i = 0; i < 4; i++) { env.t += 16; env.frame({ rms: 1, bass: 1, vocal: 1 }); f = ar.getFrame(32 + i * 16); }
  assert(f.energy > e1 && f.energy > 0.5 && f.energy < 1.0001, 'Energy attacks upward smoothly');
  assert(f.vocal > 0.5 && f.vocal <= 1, 'Vocal attacks upward');
  for (let i = 0; i < 30; i++) { env.t += 16; env.frame({ rms: 1, bass: 1, vocal: 1 }); f = ar.getFrame(100 + i * 16); }
  assert(f.energy > 0.98, 'Energy converges to the input level');

  // release: slower than attack (~250ms)
  const before = f.energy;
  for (let i = 0; i < 6; i++) { env.t += 16; env.frame({ rms: 0, bass: 0, vocal: 0 }); f = ar.getFrame(600 + i * 16); }
  assert(f.energy < before && f.energy > 0.5, 'Energy releases slowly (no instant drop)');
  for (let i = 0; i < 60; i++) { env.t += 16; env.frame({ rms: 0, bass: 0, vocal: 0, silent: false }); f = ar.getFrame(800 + i * 16); }
  assert(f.energy < 0.05, 'Energy eventually decays to ~0');

  // interpolation: getFrame between native frames changes smoothly (no stair-steps)
  env.t += 40; env.frame({ rms: 1, bass: 1, vocal: 1 });
  const vals = [];
  for (let i = 0; i < 5; i++) { env.t += 8; vals.push(ar.getFrame(2000 + i * 8).energy); }
  let mono = true;
  for (let i = 1; i < vals.length; i++) if (!(vals[i] > vals[i - 1])) mono = false;
  assert(mono, 'getFrame() between native frames keeps moving (interpolates at rAF rate)');

  // beat envelope: peak -> 0 over ~180ms
  env.t += 500; ar.getFrame(3000);
  env.frame({ beat: true, beatStrength: 0.8, rms: 0.5 });
  const b0 = ar.getFrame(3000).beat;
  env.t += 90; const b90 = ar.getFrame(3090).beat;
  env.t += 90; const b180 = ar.getFrame(3180).beat;
  env.t += 60; const b240 = ar.getFrame(3240).beat;
  assert(near(b0, 0.8, 0.001), 'Beat envelope starts at beatStrength');
  assert(b90 > 0.25 && b90 < 0.55, 'Beat envelope is about half after 90ms');
  assert(b180 < 0.02 && b240 === 0, 'Beat envelope is ~0 after ~180ms');
  assert(b0 > b90 && b90 > b180, 'Beat envelope decays monotonically');

  env.t += 300; env.frame({ beat: true, beatStrength: 0, rms: 0.5 });
  assert(near(ar.getFrame(3500).beat, 1, 0.001), 'beat:true with beatStrength 0 still pulses at full strength');
  env.t += 40; env.frame({ beat: true, beatStrength: 1, rms: 0.5 });
  assert(ar.getFrame(3540).beat < 1 && ar.getFrame(3540).beat > 0.7, 'Duplicate onsets within 100ms are ignored');

  // bpm: native bpm, 0 falls back to lyrics-derived tempo
  ar.setLyrics(makeLines(120, 4, 8));
  env.t += 2000; ar.getFrame(5000);
  for (let i = 0; i < 80; i++) { env.t += 16; env.frame({ bpm: 128 }); f = ar.getFrame(5000 + i * 16); }
  assert(f.bpm > 120 && f.bpm <= 128.001, 'bpm follows the native estimate');

  // pausing damps the signal
  ar.setPlaying(false);
  for (let i = 0; i < 80; i++) { env.t += 16; env.frame({ rms: 1, bass: 1, vocal: 1 }); f = ar.getFrame(8000); }
  assert(f.energy < 0.05 && f.vocal < 0.05, 'Paused -> reactive values fade to 0');

  ar.disable();
  assert(globalThis.window.__lyricwaveAudioFrame === prevFrame, 'disable() restores the previous frame handler');
  assert(ar.mode === 'off' && ar.getFrame(0).energy === 0, 'disable() -> off, zeros');
  delete globalThis.window.__lyricwaveAudioFrame;
}

// ---------------------------------------------------------------- watchdog: silent / missing frames -> lyrics
{
  // silent for >3s while playing
  const env = makeEnv();
  const modes = [];
  const ar = new AudioReactive({ bridge: env.bridge, now: env.now });
  ar.onModeChange = (m) => modes.push(m);
  ar.setLyrics(makeLines(120, 4, 20));
  ar.setPlaying(true);
  await ar.enable();
  assert(ar.mode === 'audio', 'Starts in audio mode');
  for (let i = 0; i < 100; i++) { // 2.5s of silent frames
    env.t += 25; env.frame({ silent: true, rms: 0, bass: 0, mid: 0, vocal: 0, high: 0 }); ar.getFrame(5000 + i * 25);
  }
  assert(ar.mode === 'audio', 'Silent for 2.5s: still audio');
  for (let i = 0; i < 30; i++) {
    env.t += 25; env.frame({ silent: true, rms: 0, bass: 0, mid: 0, vocal: 0, high: 0 }); ar.getFrame(7500 + i * 25);
  }
  assert(ar.mode === 'lyrics', 'Silent for >3s -> switches to lyrics');
  assert(modes.join() === 'audio,lyrics', 'onModeChange fired for the fallback');
  const lf = ar.getFrame(4100);
  assert(lf.mode === 'lyrics' && lf.energy > 0, 'Lyrics fallback produces a signal');

  // recovery when real frames show up
  for (let i = 0; i < 8; i++) { env.t += 25; env.frame({ rms: 0.7 }); ar.getFrame(9000); }
  assert(ar.mode === 'audio' && modes.join() === 'audio,lyrics,audio', 'Real frames resume -> back to audio');
  ar.disable();
  delete globalThis.window.__lyricwaveAudioFrame;
}
{
  // frames never arrive within 3s
  const env = makeEnv();
  const modes = [];
  const ar = new AudioReactive({ bridge: env.bridge, now: env.now });
  ar.onModeChange = (m) => modes.push(m);
  ar.setPlaying(true);
  await ar.enable();
  for (let i = 0; i < 5; i++) { env.t += 500; ar.getFrame(0); }
  assert(ar.mode === 'audio', 'No frames for 2.5s: still audio');
  env.t += 600; ar.getFrame(0);
  assert(ar.mode === 'lyrics' && modes.join() === 'audio,lyrics', 'No frames for >3s -> lyrics + onModeChange');
  ar.disable();
}
{
  // paused: silence must not trigger the fallback; counting starts at playback
  const env = makeEnv();
  const ar = new AudioReactive({ bridge: env.bridge, now: env.now });
  await ar.enable();
  env.t += 10000; ar.getFrame(0);
  assert(ar.mode === 'audio', 'Paused for 10s: no fallback');
  ar.setPlaying(true);
  for (let i = 0; i < 4; i++) { env.t += 500; ar.getFrame(0); }
  assert(ar.mode === 'audio', 'Counting restarts when playback starts');
  for (let i = 0; i < 3; i++) { env.t += 500; ar.getFrame(0); }
  assert(ar.mode === 'lyrics', 'Playing without frames for >3s -> lyrics');
  ar.disable();

  // a long gap between getFrame() calls (backgrounded app) is not blamed on the stream
  const env2 = makeEnv();
  const ar2 = new AudioReactive({ bridge: env2.bridge, now: env2.now });
  ar2.setPlaying(true);
  await ar2.enable();
  env2.frame({ rms: 0.5 }); ar2.getFrame(0);
  env2.t += 60000; // app in background: no rAF, no frames
  ar2.getFrame(0);
  assert(ar2.mode === 'audio', 'Backgrounded gap does not cause a fallback');
  ar2.disable();
}

// ---------------------------------------------------------------- lyrics mode: beat grid, vocal, determinism
{
  const lines = makeLines(120, 4, 16); // line every 2000ms starting at 4000
  const ar = new AudioReactive({ bridge: null });
  await ar.enable();
  ar.setLyrics(lines);
  assert(near(ar.lyricsBpm, 120, 1), 'lyricsBpm exposes the estimated tempo');

  ar.setPlaying(false);
  let f = ar.getFrame(4100);
  assert(f.energy === 0 && f.beat === 0 && f.vocal === 0, 'Paused -> zeros in lyrics mode');
  ar.setPlaying(true);

  f = ar.getFrame(3000);
  assert(f.energy === 0 && f.beat === 0, 'Before the first line -> zeros');
  assert(near(ar.getFrame(4000).beat, 0.85, 0.001), 'Beat grid is phase-locked to the line start (downbeat)');
  assert(ar.getFrame(4090).beat < ar.getFrame(4000).beat, 'Beat decays after the downbeat');
  assert(ar.getFrame(4250).beat === 0, 'No beat between grid points');
  assert(ar.getFrame(4500).beat > 0.4, 'Second beat lands 500ms (=120 bpm) after the line start');
  assert(ar.getFrame(6000).beat > 0.8, 'Grid re-locks on the next line start');
  assert(ar.getFrame(4100).bpm >= 119 && ar.getFrame(4100).bpm <= 121, 'bpm is reported in lyrics mode');

  // vocal envelope: bounded, gentle, onset bumps at word starts
  let min = 1, max = 0;
  for (let p = 4000; p < 6000; p += 10) {
    const v = ar.getFrame(p).vocal;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert(min >= 0.29 && max <= 0.9, 'Vocal envelope stays gentle (sustain ~0.3, peaks < 0.9)');
  // line "la la la line number 0" has 6 words over 2000ms -> onset at 4000+333*k
  assert(ar.getFrame(4333 + 50).vocal > ar.getFrame(4333 + 250).vocal, 'Vocal bumps at a word onset then relaxes');
  const e = ar.getFrame(4100);
  assert(e.energy > 0 && e.energy <= 1 && e.vocal <= 1 && e.beat <= 1, 'All outputs are within 0..1');

  // empty line (instrumental marker) silences vocal and beat
  const withBreak = lines.slice();
  withBreak.splice(4, 0, { timeMs: 11000, text: '' });
  ar.setLyrics(withBreak);
  assert(ar.getFrame(11500).vocal === 0 && ar.getFrame(11500).beat === 0, 'Empty marker line -> no vocal / beat');

  // determinism / seek-safety: same position -> same frame regardless of history
  ar.setLyrics(lines);
  const positions = [4000, 4123, 5000, 7777, 9100, 12000, 15999, 4123, 30000, 4000];
  const first = positions.map(p => JSON.stringify(ar.getFrame(p)));
  const reversed = positions.slice().reverse().map(p => JSON.stringify(ar.getFrame(p))).reverse();
  assert(first.every((s, i) => s === reversed[i]), 'Lyrics mode is deterministic regardless of seek order');
  const ar2 = new AudioReactive({ bridge: null });
  await ar2.enable();
  ar2.setLyrics(lines);
  ar2.setPlaying(true);
  assert(JSON.stringify(ar2.getFrame(7777)) === first[3], 'A fresh instance gives the identical frame for the same position');
  assert(ar.getFrame(NaN).mode === 'lyrics' && ar.getFrame(undefined).energy >= 0, 'Bad positions never throw');

  // active line from the reel is used only when no lyrics were set
  const ar3 = new AudioReactive({ bridge: null });
  await ar3.enable();
  ar3.setPlaying(true);
  assert(ar3.getFrame(1000).vocal === 0, 'No lyrics / no active line -> zeros');
  ar3.setActiveLine({ timeMs: 1000, text: 'one two three four' }, 5000);
  assert(ar3.getFrame(1500).vocal > 0.29, 'Active line from the reel drives the vocal envelope');
  assert(ar3.getFrame(1500).beat === 0, 'Without a tempo estimate there is no (fake) beat');

  ar.disable(); ar2.disable(); ar3.disable();
}

// ---------------------------------------------------------------- Reel (Sprint 2 additions, Node safe)
console.log('--- Testing ReelVisualizer Sprint 2 API ---');
{
  const calls = { clearRect: 0, stroke: 0 };
  const mockCtx = {
    setTransform: () => {}, scale: () => {},
    clearRect: () => { calls.clearRect++; },
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    stroke: () => { calls.stroke++; }
  };
  const mockCanvas = { getContext: () => mockCtx, getBoundingClientRect: () => ({ width: 800, height: 400 }), width: 800, height: 400 };

  const reel = new ReelVisualizer(mockCanvas, null, { theme: 'pixel', wordByWordMode: true });
  assert(reel.animationStyle === 'pulse', "Default animation style is 'pulse'");
  reel.setActiveLine({ timeMs: 10000, text: 'Hello world this is LyricWave' }, 0, 15000);

  let s = reel.render(10500, true);
  const keys = ['words', 'currentWordIndex', 'wordByWordMode', 'wordProgress', 'beat', 'vocal', 'energy', 'bpm', 'mode', 'animationStyle'];
  assert(keys.every(k => k in s), 'render() returns all C3 fields');
  assert(s.beat === 0 && s.vocal === 0 && s.energy === 0 && s.mode === 'off', 'Without an audio source the reactive fields are zero/off');
  assert(s.animationStyle === 'pulse', 'render() reports the animation style');
  assert(near(s.wordProgress, 0.5, 0.001) && s.currentWordIndex === 0, 'wordProgress is 0..1 within the current word (10500 -> 0.5)');
  assert(near(reel.render(12250, true).wordProgress, 0.25, 0.001), 'wordProgress at 12250ms is 0.25 of "this"');
  assert(reel.render(9000, true).wordProgress === 0, 'wordProgress is 0 before the line');

  reel.setAnimationStyle('karaoke');
  assert(reel.animationStyle === 'karaoke', 'setAnimationStyle(karaoke)');
  reel.setAnimationStyle('bogus');
  assert(reel.animationStyle === 'karaoke', 'Unknown style is ignored');
  reel.setWordByWordMode(false);
  s = reel.render(10500, true);
  assert(s.currentWordIndex === 0 && near(s.wordProgress, 0.5, 0.001), 'Karaoke tracks words even when word-by-word reveal is off');
  reel.setWordByWordMode(true);

  // pulse with a fake audio source
  let playingSeen = null;
  const fake = {
    mode: 'audio',
    setPlaying: (p) => { playingSeen = p; },
    getFrame: () => ({ energy: 5, beat: 5, vocal: 0.5, bpm: 128, mode: 'audio' })
  };
  reel.setAudioReactive(fake);
  reel.setAnimationStyle('pulse');
  s = reel.render(11000, true);
  assert(s.beat === 1 && s.energy === 1 && s.vocal === 0.5, 'Reactive outputs are clamped to 0..1');
  assert(s.bpm === 128 && s.mode === 'audio', 'bpm and mode are passed through');
  assert(playingSeen === true, 'Reel keeps the source informed about play state');
  assert(reel._ampMul <= 1.181 && reel._ampMul >= 1.17, 'Pulse amplitude boost is capped (8% beat + 10% energy)');
  const beatOnly = { mode: 'audio', getFrame: () => ({ energy: 0, beat: 1, vocal: 0, bpm: 0, mode: 'audio' }) };
  reel.setAudioReactive(beatOnly);
  reel.render(11000, true);
  assert(near(reel._ampMul, 1.08, 1e-9), 'A full beat adds at most 8% amplitude');
  assert(reel._alphaMul > 1 && reel._alphaMul <= 1.5, 'Brightness lift is bounded');

  reel.setAudioReactive(fake);
  reel.setAnimationStyle('reveal');
  s = reel.render(11000, true);
  assert(s.beat === 0 && s.energy === 0 && s.animationStyle === 'reveal' && reel._ampMul === 1, "'reveal' does not pulse (previous behaviour)");
  reel.setAnimationStyle('karaoke');
  s = reel.render(11000, true);
  assert(s.beat === 0 && reel._ampMul === 1, "'karaoke' does not pulse the waves");

  // throwing source never breaks the reel
  reel.setAnimationStyle('pulse');
  reel.setAudioReactive({ mode: 'audio', getFrame: () => { throw new Error('boom'); } });
  let threw = false;
  try { s = reel.render(11000, true); } catch { threw = true; }
  assert(!threw && s.beat === 0, 'A throwing audio source is contained');
  reel.setAudioReactive(null);
  assert(reel.audioReactive === null, 'setAudioReactive(null) detaches');

  // real AudioReactive wired to the reel (setActiveLine forwarding)
  const ar = new AudioReactive({ bridge: null });
  await ar.enable();
  const lines = makeLines(120, 4, 8, 10000);
  ar.setLyrics(lines);
  reel.setAudioReactive(ar);
  reel.setActiveLine(lines[1], 1, lines[2].timeMs);
  s = reel.render(lines[1].timeMs + 10, true);
  assert(s.mode === 'lyrics' && s.energy > 0 && s.bpm > 100, 'Reel + AudioReactive(lyrics) integration yields a signal');
  assert(s.beat > 0.5, 'Beat is visible right at a line start');
  ar.disable();
  reel.setAudioReactive(null);

  // reduced motion: no pulsing, stepped highlight
  reel.setAudioReactive(fake);
  reel.reducedMotion = true;
  reel._staticDirty = true;
  s = reel.render(lines[1].timeMs + 100, true);
  assert(s.beat === 0 && s.vocal === 0 && s.energy === 0, 'Reduced motion: no reactive pulsing');
  assert(s.wordProgress === 1, 'Reduced motion: static (fully lit) highlight');
  reel.reducedMotion = false;
  reel.setAudioReactive(null);

  // minimal: static waves are painted once, not every frame
  reel.setAnimationStyle('minimal');
  calls.clearRect = 0;
  for (let i = 0; i < 10; i++) reel.render(10000 + i * 16, true);
  assert(calls.clearRect === 1, "'minimal' paints static waves once (no per-frame redraw)");
  reel.setTheme('ocean');
  reel.render(10200, true);
  assert(calls.clearRect === 2, 'Static style repaints after a theme change');

  // themes (old + new) all draw without throwing and use the drawing path
  reel.setAnimationStyle('pulse');
  reel.setAudioReactive(fake);
  const themes = ['aurora', 'adaptive', 'neon', 'vinyl', 'paper', 'minimal', 'pixel', 'sunset', 'ocean', 'sakura', 'mono', 'synthwave', 'forest'];
  let allOk = true;
  for (const th of themes) {
    reel.setTheme(th);
    reel.minFrameIntervalMs = 0;
    calls.stroke = 0;
    try { reel.render(12000, true); } catch { allOk = false; }
    if (calls.stroke === 0) allOk = false;
  }
  assert(allOk, 'All 13 themes draw without throwing');

  // new themes use the token drawer (read --wave-1/--wave-2)
  const requested = [];
  reel.getCssToken = (name, fallback) => { requested.push(name); return fallback; };
  for (const th of ['sunset', 'ocean', 'sakura', 'forest', 'synthwave']) {
    requested.length = 0;
    reel.setTheme(th);
    reel.render(12000, true);
    assert(requested.includes('--wave-1') && requested.includes('--wave-2'), `Theme ${th} reads --wave-1/--wave-2`);
  }
  requested.length = 0;
  reel.setTheme('mono');
  reel.render(12000, true);
  assert(requested.length === 0, 'Mono draws crisp white lines without CSS tokens');
}

console.log(`\nAudioReactive tests completed: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
process.exit(0);
