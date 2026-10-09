/**
 * LyricWave fullscreen beat visuals
 *
 * A canvas layer that fills the reel while it is fullscreen and pulses with the AudioReactive frame
 * ({ beat, energy, vocal } in 0..1): a centre bloom that swells on each beat, rings that ripple outward
 * from every beat onset, and a drifting neon particle field whose speed follows the energy.
 * It also feeds `--fs-beat` / `--fs-energy` to the container, which drive the CSS laser border.
 *
 * Design notes
 *  - Only draws while active (fullscreen); inactive it clears once and does nothing per frame.
 *  - No per-frame allocation: rings and particles live in fixed pools.
 *  - Reduced motion: a still, dim bloom and no rings, particles or border pulse.
 *  - The pure helpers (`computeVisualParams`, `detectOnset`) carry the beat -> visuals mapping and are unit-tested.
 */

const MAX_RINGS = 8;
const RING_LIFE_MS = 1100;
const PARTICLE_COUNT = 56;
const ONSET_THRESHOLD = 0.55;     // a beat counts once its envelope rises past this
const ONSET_REARM = 0.2;          // ... and must fall below this before the next one counts
const MIN_ONSET_GAP_MS = 140;
const HUE_SPEED_DEG_PER_MS = 0.012; // a slow colour drift (one full turn every 30 s)
const NEON_HUES = [300, 190, 120, 45]; // magenta, cyan, green, amber

function clamp01(v) {
  return v > 1 ? 1 : v > 0 ? v : 0;
}

/**
 * Map one AudioReactive frame to drawing parameters. Pure.
 * @returns {{bloomRadius:number, bloomAlpha:number, particleSpeed:number, particleAlpha:number, borderGlow:number}}
 *          bloomRadius is a fraction of the shorter screen side.
 */
export function computeVisualParams(frame, reducedMotion = false) {
  const beat = clamp01(frame && frame.beat);
  const energy = clamp01(frame && frame.energy);
  const vocal = clamp01(frame && frame.vocal);
  if (reducedMotion) {
    return { bloomRadius: 0.45, bloomAlpha: 0.18, particleSpeed: 0, particleAlpha: 0, borderGlow: 0.35 };
  }
  return {
    bloomRadius: 0.32 + 0.22 * energy + 0.14 * beat,
    bloomAlpha: Math.min(0.75, 0.14 + 0.38 * beat + 0.18 * energy + 0.08 * vocal),
    particleSpeed: 0.25 + 1.6 * energy + 1.2 * beat,
    particleAlpha: Math.min(1, 0.35 + 0.4 * energy + 0.3 * beat),
    borderGlow: clamp01(0.35 + 0.65 * beat + 0.2 * energy)
  };
}

/**
 * Rising-edge beat detector with hysteresis. Pure: returns the new state and whether an onset fired.
 * @param {{armed:boolean, lastAt:number}} state
 */
export function detectOnset(state, beat, nowMs) {
  const b = clamp01(beat);
  if (state.armed && b >= ONSET_THRESHOLD && nowMs - state.lastAt >= MIN_ONSET_GAP_MS) {
    return { state: { armed: false, lastAt: nowMs }, onset: true };
  }
  if (!state.armed && b <= ONSET_REARM) {
    return { state: { armed: true, lastAt: state.lastAt }, onset: false };
  }
  return { state, onset: false };
}

export class BeatVisuals {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} container element that receives the --fs-beat / --fs-energy CSS variables
   * @param {{minFrameIntervalMs?:number}} [options]
   */
  constructor(canvas, container, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    this.container = container;
    this.minFrameIntervalMs = options.minFrameIntervalMs || 0;
    this.active = false;
    this.width = 0;
    this.height = 0;
    this._lastDraw = 0;
    this._lastNow = 0;
    this._onset = { armed: true, lastAt: -Infinity };
    this._cssBeat = -1;
    this._cssEnergy = -1;
    this.reducedMotion = false;

    this._rings = [];
    for (let i = 0; i < MAX_RINGS; i++) this._rings.push({ bornAt: -Infinity, hue: 0, strength: 0 });
    this._ringNext = 0;

    this._particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this._particles.push({ angle: 0, dist: 0, spin: 0, size: 0, hue: 0 });
      this._resetParticle(this._particles[i], true);
    }

    if (typeof window !== 'undefined' && window.matchMedia) {
      const q = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = q.matches;
      const onChange = (e) => { this.reducedMotion = e.matches; };
      if (typeof q.addEventListener === 'function') q.addEventListener('change', onChange);
      else if (typeof q.addListener === 'function') q.addListener(onChange);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', () => { if (this.active) this.resize(); });
    }
  }

  _resetParticle(p, scatter) {
    p.angle = Math.random() * Math.PI * 2;
    p.dist = scatter ? Math.random() : 0.05 + Math.random() * 0.1; // fraction of the half-diagonal
    p.spin = (Math.random() - 0.5) * 0.0006;
    p.size = 1 + Math.random() * 2.2;
    p.hue = NEON_HUES[(Math.random() * NEON_HUES.length) | 0];
  }

  setActive(active) {
    const next = Boolean(active);
    if (next === this.active) return;
    this.active = next;
    this._onset = { armed: true, lastAt: -Infinity };
    for (const r of this._rings) r.bornAt = -Infinity;
    if (next) this.resize();
    else {
      this._clear();
      this._setCss(0, 0);
    }
  }

  resize() {
    if (!this.canvas || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    this.width = rect.width || (typeof window !== 'undefined' ? window.innerWidth : 0);
    this.height = rect.height || (typeof window !== 'undefined' ? window.innerHeight : 0);
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _clear() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.width, this.height);
  }

  _setCss(beat, energy) {
    if (!this.container || !this.container.style) return;
    if (Math.abs(beat - this._cssBeat) > 0.02 || (beat === 0 && this._cssBeat !== 0)) {
      this._cssBeat = beat;
      this.container.style.setProperty('--fs-beat', beat.toFixed(2));
    }
    if (Math.abs(energy - this._cssEnergy) > 0.02 || (energy === 0 && this._cssEnergy !== 0)) {
      this._cssEnergy = energy;
      this.container.style.setProperty('--fs-energy', energy.toFixed(2));
    }
  }

  /**
   * Draw one frame. `frame` is an AudioReactive frame ({ beat, energy, vocal }); `nowMs` a monotonic clock.
   */
  render(frame, nowMs) {
    if (!this.active || !this.ctx) return;
    if (this.minFrameIntervalMs && nowMs - this._lastDraw < this.minFrameIntervalMs) return;
    const dt = this._lastNow ? Math.min(100, nowMs - this._lastNow) : 16;
    this._lastNow = nowMs;
    this._lastDraw = nowMs;

    const reduced = this.reducedMotion;
    const beat = reduced ? 0 : clamp01(frame && frame.beat);
    const energy = reduced ? 0 : clamp01(frame && frame.energy);
    const p = computeVisualParams(frame, reduced);
    this._setCss(beat, energy);

    const hue = reduced ? NEON_HUES[0] : (nowMs * HUE_SPEED_DEG_PER_MS) % 360;
    if (!reduced) {
      const r = detectOnset(this._onset, beat, nowMs);
      this._onset = r.state;
      if (r.onset) {
        const ring = this._rings[this._ringNext];
        this._ringNext = (this._ringNext + 1) % MAX_RINGS;
        ring.bornAt = nowMs;
        ring.hue = (hue + NEON_HUES[this._ringNext % NEON_HUES.length]) % 360;
        ring.strength = 0.5 + 0.5 * beat;
      }
    }

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const short = Math.min(w, h);
    const halfDiag = Math.hypot(w, h) / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // 1. Centre bloom
    const radius = Math.max(1, short * p.bloomRadius * 1.6);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, `hsla(${hue}, 100%, 60%, ${p.bloomAlpha})`);
    g.addColorStop(0.45, `hsla(${(hue + 60) % 360}, 100%, 50%, ${p.bloomAlpha * 0.45})`);
    g.addColorStop(1, `hsla(${(hue + 120) % 360}, 100%, 45%, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    if (!reduced) {
      // 2. Beat rings rippling outward
      for (const ring of this._rings) {
        const age = nowMs - ring.bornAt;
        if (!(age >= 0 && age < RING_LIFE_MS)) continue;
        const t = age / RING_LIFE_MS;
        const ease = 1 - (1 - t) * (1 - t);
        ctx.beginPath();
        ctx.arc(cx, cy, short * 0.12 + ease * halfDiag, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${ring.hue}, 100%, 62%, ${(1 - t) * 0.6 * ring.strength})`;
        ctx.lineWidth = 1 + 5 * (1 - t);
        ctx.stroke();
      }

      // 3. Particle field drifting outward, faster with energy
      const step = dt * 0.00012 * p.particleSpeed;
      for (const pt of this._particles) {
        pt.dist += step * (0.4 + pt.dist);
        pt.angle += pt.spin * dt;
        if (pt.dist > 1) this._resetParticle(pt, false);
        const d = pt.dist * halfDiag;
        const x = cx + Math.cos(pt.angle) * d;
        const y = cy + Math.sin(pt.angle) * d;
        ctx.fillStyle = `hsla(${(pt.hue + hue) % 360}, 100%, 65%, ${p.particleAlpha * Math.min(1, pt.dist * 4)})`;
        ctx.fillRect(x - pt.size / 2, y - pt.size / 2, pt.size, pt.size);
      }
    }

    ctx.globalCompositeOperation = 'source-over';
  }
}

export default BeatVisuals;
