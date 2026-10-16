/**
 * Unit tests for the fullscreen beat visuals (visuals.js)
 */

import { BeatVisuals, computeVisualParams, detectOnset } from './visuals.js';
import { synthesizePcm, isProjectMSupported } from './projectm-visualizer.js';

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

// The Android WebView has no Fullscreen API: the visuals must also run in CSS pseudo-fullscreen.
{
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const toggle = app.slice(app.indexOf('function toggleFullscreen()'), app.indexOf('function trapFocus('));
  assert(/IS_NATIVE_APP[^\n]*\n\s*setPseudoFullscreen\(true\)/.test(toggle), 'native app goes straight to pseudo-fullscreen');
  assert(/\.catch\?\.\(fallback\)/.test(toggle) && /setTimeout\(fallback, FULLSCREEN_SETTLE_MS\)/.test(toggle),
    'a refused or stuck Fullscreen request falls back to pseudo-fullscreen');
  assert(!/stageOpen \|\| document\.fullscreenElement/.test(app) && /stageOpen \|\| isReelFullscreen\(\)/.test(app),
    'the stage tick (which drives the visuals) runs in pseudo-fullscreen');
  assert(/isReelFullscreen\(\);\s*\n\s*document\.body\.classList\.toggle\('fullscreen-reel-mode'/.test(app)
    && /beatVisuals\?\.setActive\(isFs\)/.test(app), 'pseudo-fullscreen activates the beat visuals');
  assert(/\.reel-container\.is-pseudo-fs \.fs-visuals-canvas/.test(css) && /\.reel-container\.is-pseudo-fs \.fs-laser\b/.test(css),
    'CSS shows the visuals canvas and laser border in pseudo-fullscreen');
  assert(/pseudoFullscreen && !landed\.includes\('fs'\)/.test(app), 'Android Back leaves pseudo-fullscreen before the stage');
  assert(/pseudoFullscreen && !landed\.includes\('fs'\) && !navPushQueue\.includes\('fs'\)/.test(app),
    'closing the More sheet as Fullscreen is tapped does not immediately exit fullscreen');
}

// --- projectM beat-synth ------------------------------------------------------
{
  const rms = (a) => Math.sqrt(a.reduce((x, v) => x + v * v, 0) / a.length);
  const state = { phase: [0, 0, 0, 0, 0], seed: 1, kick: 0 };
  const quiet = rms(synthesizePcm({ beat: 0, energy: 0, vocal: 0 }, state, new Float32Array(1024)));
  const loud = rms(synthesizePcm({ beat: 1, energy: 1, vocal: 1 }, state, new Float32Array(1024)));
  assert(loud > quiet * 5, 'projectM synth: a beat frame is much louder than silence');
  const block = synthesizePcm({ beat: 1, energy: 1, vocal: 1 }, { phase: [0, 0, 0, 0, 0], seed: 1, kick: 0 }, new Float32Array(2048));
  assert(block.every((v) => v >= -1 && v <= 1), 'projectM synth: samples stay within [-1, 1]');
  const s2 = { phase: [0, 0, 0, 0, 0], seed: 1, kick: 0 };
  const a = synthesizePcm({ energy: 0.5 }, s2, new Float32Array(256));
  const b = synthesizePcm({ energy: 0.5 }, s2, new Float32Array(256));
  assert(Math.abs(a[255] - b[0]) < 0.2, 'projectM synth: waveform is continuous across blocks');
  assert(isProjectMSupported() === false, 'projectM support probe is false without a DOM (and never throws)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
