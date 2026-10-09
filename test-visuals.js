/**
 * Unit tests for the fullscreen beat visuals (visuals.js)
 */

import { BeatVisuals, computeVisualParams, detectOnset } from './visuals.js';

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

console.log('--- Testing BeatVisuals ---');

// computeVisualParams: louder / on-beat frames draw bigger and brighter, values stay in range
const quiet = computeVisualParams({ beat: 0, energy: 0, vocal: 0 });
const loud = computeVisualParams({ beat: 1, energy: 1, vocal: 1 });
assert(loud.bloomRadius > quiet.bloomRadius, 'bloom grows with beat + energy');
assert(loud.bloomAlpha > quiet.bloomAlpha && loud.bloomAlpha <= 0.75, 'bloom brightens on the beat, capped at 0.75');
assert(loud.particleSpeed > quiet.particleSpeed, 'particles speed up with energy');
assert(loud.borderGlow === 1 && quiet.borderGlow > 0, 'border glow spans 0.35..1');
const junk = computeVisualParams({ beat: NaN, energy: 5, vocal: -1 });
assert(Object.values(junk).every(Number.isFinite), 'bad frame values are clamped, never NaN');
assert(Object.values(computeVisualParams(null)).every(Number.isFinite), 'a missing frame is treated as silence');
const still = computeVisualParams({ beat: 1, energy: 1, vocal: 1 }, true);
assert(still.particleSpeed === 0 && still.particleAlpha === 0, 'reduced motion: no particles');
assert(still.bloomRadius === computeVisualParams({ beat: 0 }, true).bloomRadius, 'reduced motion: bloom ignores the beat');

// detectOnset: one onset per beat envelope, re-armed only after it falls back
let st = { armed: true, lastAt: -Infinity };
let r = detectOnset(st, 0.9, 1000);
assert(r.onset === true, 'rising beat fires an onset');
st = r.state;
r = detectOnset(st, 0.8, 1020);
assert(r.onset === false, 'the same beat does not fire twice');
st = r.state;
r = detectOnset(st, 0.1, 1100);
st = r.state;
assert(st.armed === true, 're-arms once the envelope decays');
r = detectOnset(st, 0.9, 1120);
assert(r.onset === false, 'onsets closer than 140ms are ignored');
r = detectOnset(r.state, 0.9, 1200);
assert(r.onset === true, 'next beat after the gap fires');
assert(detectOnset({ armed: true, lastAt: -Infinity }, 0.3, 0).onset === false, 'a weak envelope is not a beat');

// BeatVisuals with a mock canvas: inactive draws nothing, active draws and feeds CSS vars
const calls = { clear: 0, fill: 0, arc: 0 };
const ctx = {
  setTransform() {}, clearRect() { calls.clear++; }, fillRect() { calls.fill++; },
  beginPath() {}, arc() { calls.arc++; }, stroke() {},
  createRadialGradient: () => ({ addColorStop() {} }),
  globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1
};
const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: 1280, height: 720 }), width: 0, height: 0 };
const vars = {};
const container = { style: { setProperty: (k, v) => { vars[k] = v; } } };
const v = new BeatVisuals(canvas, container);

v.render({ beat: 1, energy: 1 }, 0);
assert(calls.fill === 0, 'inactive: render draws nothing');
v.setActive(true);
assert(canvas.width === 1280 && canvas.height === 720, 'activating sizes the canvas');
v.render({ beat: 0, energy: 0.5 }, 16);
assert(calls.fill > 1, 'active: bloom + particles drawn');
assert(calls.arc === 0, 'no ring before a beat');
v.render({ beat: 0.9, energy: 0.6 }, 400);
assert(calls.arc === 1, 'a beat spawns a ring');
assert(vars['--fs-beat'] === '0.90', '--fs-beat follows the beat');
assert(vars['--fs-energy'] === '0.60', '--fs-energy follows the energy');
v.setActive(false);
assert(vars['--fs-beat'] === '0.00' && vars['--fs-energy'] === '0.00', 'deactivating resets the CSS vars');

const throttled = new BeatVisuals(canvas, container, { minFrameIntervalMs: 33 });
throttled.setActive(true);
const before = calls.fill;
throttled.render({ beat: 0 }, 100);
const afterFirst = calls.fill;
throttled.render({ beat: 0 }, 110);
assert(afterFirst > before && calls.fill === afterFirst, '30fps throttle skips frames inside the interval');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
