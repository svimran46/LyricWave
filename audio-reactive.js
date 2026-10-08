/**
 * LyricWave audio-reactive module (Sprint 2, contract C2)
 *
 * One small API (`getFrame(positionMs)`) hides where the "beat / vocal / energy" signal comes from:
 *
 *   'audio'  - native Android Visualizer frames pushed into `window.__lyricwaveAudioFrame` (contract C1).
 *   'lyrics' - fallback ("lyric rhythm"): tempo estimated from synced-line timing + evenly-split word onsets.
 *              A PURE function of (positionMs, lyrics, playing) -> seek-safe and deterministic.
 *   'off'    - zeros.
 *
 * Design notes
 *  - No dependencies, never throws, works in Node (no `window`): every host access is guarded.
 *  - Time is injectable (`now`, `timers`) so the 3s watchdogs are unit-testable without waiting.
 *  - Audio mode is smoothed with attack ~60ms / release ~250ms (exponential, evaluated at the rAF rate,
 *    which also interpolates between the 20-25 fps native frames). The beat is an analytic envelope
 *    (peak -> 0 over 180ms), so it is smooth at any display rate and independent of native frame jitter.
 *  - Nothing is recorded or stored: only a handful of floats per frame are kept.
 */

export const MODE_AUDIO = 'audio';
export const MODE_LYRICS = 'lyrics';
export const MODE_OFF = 'off';

const BEAT_DECAY_MS = 180;
const ATTACK_MS = 60;
const RELEASE_MS = 250;
const SILENCE_TIMEOUT_MS = 3000;
const FRAME_HOLD_MS = 300;         // hold last frame values this long if frames stop arriving, then fade out
const MIN_BEAT_GAP_MS = 100;       // JS-side guard against duplicate onsets (native already has a 250ms refractory)
const RECOVER_STREAK = 5;          // consecutive non-silent frames needed to leave the 'lyrics' fallback
const DEFAULT_PERMISSION_TIMEOUT_MS = 20000;

const TEMPO_MIN = 70;
const TEMPO_MAX = 180;
const TEMPO_PREFERRED = 110;
const BEATS_PER_LINE_CANDIDATES = [2, 4, 8];
const MIN_LINE_INTERVAL_MS = 500;
const MAX_LINE_INTERVAL_MS = 12000;
const MAX_BEAT_REGION_MS = 12000;

const BRIDGE_METHODS = [
  'audioReactiveSupported',
  'hasAudioPermission',
  'requestAudioPermission',
  'startAudioReactive',
  'stopAudioReactive'
];

function clamp01(v) {
  return v > 1 ? 1 : v > 0 ? v : 0;
}

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function defaultNow() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch { /* ignore */ }
  return Date.now();
}

function getHost() {
  if (typeof window !== 'undefined') return window;
  return globalThis;
}

function getDefaultBridge() {
  try {
    if (typeof window !== 'undefined' && window.LyricWaveNative) return window.LyricWaveNative;
  } catch { /* ignore */ }
  return null;
}

function countWords(text) {
  if (typeof text !== 'string') return 0;
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * Same word-timing model as reel.js: the line duration is split evenly between its words.
 * Returns { words, durationMs } (durationMs is what the words are spread over).
 */
export function computeLineTiming(startMs, wordCount, nextLineTimeMs = 0) {
  const words = Math.max(0, wordCount | 0);
  const lineEnd = nextLineTimeMs > startMs
    ? Math.min(nextLineTimeMs, startMs + 9000)
    : startMs + Math.max(2500, words * 450);
  const durationMs = Math.max(1000, lineEnd - startMs);
  return { words, durationMs };
}

function sanitizeLines(syncedLines) {
  const out = [];
  if (!Array.isArray(syncedLines)) return out;
  for (const l of syncedLines) {
    if (!l || typeof l.timeMs !== 'number' || !Number.isFinite(l.timeMs)) continue;
    out.push({ timeMs: l.timeMs, text: typeof l.text === 'string' ? l.text : '' });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  // drop exact duplicate timestamps (keep the one that has text, else the first)
  const dedup = [];
  for (const l of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.timeMs === l.timeMs) {
      if (!prev.text.trim() && l.text.trim()) dedup[dedup.length - 1] = l;
      continue;
    }
    dedup.push(l);
  }
  return dedup;
}

/**
 * Estimate tempo (bpm) from the start times of synced lyric lines.
 * Robust: median of line intervals (ignores breaks / very short artefacts), assumes a line spans
 * 2, 4 or 8 beats, folds by octaves into 70-180 bpm and prefers the candidate closest to 110 bpm.
 * @param {Array<{timeMs:number,text?:string}>} lines
 * @returns {number} bpm (one decimal) or 0 when it cannot be estimated
 */
export function estimateTempo(lines) {
  try {
    const clean = sanitizeLines(lines).filter(l => countWords(l.text) > 0);
    const intervals = [];
    for (let i = 1; i < clean.length; i++) {
      const d = clean[i].timeMs - clean[i - 1].timeMs;
      if (d >= MIN_LINE_INTERVAL_MS && d <= MAX_LINE_INTERVAL_MS) intervals.push(d);
    }
    if (intervals.length < 1) return 0;
    intervals.sort((a, b) => a - b);
    const mid = intervals.length >> 1;
    const median = intervals.length % 2 ? intervals[mid] : (intervals[mid - 1] + intervals[mid]) / 2;
    if (!(median > 0)) return 0;

    let best = 0;
    let bestScore = Infinity;
    for (const beats of BEATS_PER_LINE_CANDIDATES) {
      let bpm = (60000 * beats) / median;
      while (bpm < TEMPO_MIN) bpm *= 2;
      while (bpm > TEMPO_MAX) bpm /= 2;
      const variants = [bpm];
      if (bpm * 2 <= TEMPO_MAX) variants.push(bpm * 2);
      if (bpm / 2 >= TEMPO_MIN) variants.push(bpm / 2);
      for (const v of variants) {
        if (v < TEMPO_MIN || v > TEMPO_MAX) continue;
        const score = Math.abs(Math.log(v / TEMPO_PREFERRED));
        if (score < bestScore) { bestScore = score; best = v; }
      }
    }
    return best > 0 ? Math.round(best * 10) / 10 : 0;
  } catch {
    return 0;
  }
}

export class AudioReactive {
  /**
   * @param {object} [opts]
   * @param {object|null} [opts.bridge]  C1 native bridge (default window.LyricWaveNative)
   * @param {() => number} [opts.now]    monotonic ms clock (injectable for tests)
   * @param {{setTimeout:Function,clearTimeout:Function}} [opts.timers]
   * @param {number} [opts.permissionTimeoutMs]
   */
  constructor(opts = {}) {
    const o = opts || {};
    this._bridge = Object.prototype.hasOwnProperty.call(o, 'bridge') ? o.bridge : getDefaultBridge();
    this._now = typeof o.now === 'function' ? o.now : defaultNow;
    this._timers = o.timers || {
      setTimeout: (...a) => setTimeout(...a),
      clearTimeout: (...a) => clearTimeout(...a)
    };
    this._permissionTimeoutMs = num(o.permissionTimeoutMs, DEFAULT_PERMISSION_TIMEOUT_MS);

    this._mode = MODE_OFF;
    this._playing = false;
    this.onModeChange = () => {};

    // enable() bookkeeping
    this._enableId = 0;
    this._audioWanted = false;     // enable() succeeded in starting the native stream
    this._started = false;         // native startAudioReactive() returned true
    this._frameHost = null;
    this._frameHandler = null;
    this._prevFrameHandler = undefined;
    this._healthTimer = null;

    // audio-mode state
    this._healthSince = 0;
    this._lastGoodAt = -Infinity;
    this._goodStreak = 0;
    this._lastGetAt = -Infinity;
    this._frameAt = -Infinity;
    this._tgt = { rms: 0, bass: 0, mid: 0, vocal: 0, high: 0, bpm: 0 };
    this._sm = { energy: 0, vocal: 0 };
    this._bpmSm = 0;
    this._beatPeak = 0;
    this._beatAt = -Infinity;

    // lyrics-mode model
    this._lines = [];
    this._lt = [];       // start times
    this._wc = [];       // words per line (0 = empty / instrumental marker)
    this._dur = [];      // ms the words are spread over
    this._beatEnd = [];  // ms after line start while the beat grid is active
    this._idxHint = 0;
    this._lyricsBpm = 0;
    this._ovr = null;    // active-line override from the reel (used only when no lyrics were set)
  }

  /** True when the C1 bridge exists, has all audio methods and reports support. Never throws. */
  static isNativeAvailable(bridge = getDefaultBridge()) {
    try {
      if (!bridge) return false;
      for (const m of BRIDGE_METHODS) {
        if (typeof bridge[m] !== 'function') return false;
      }
      return bridge.audioReactiveSupported() === true;
    } catch {
      return false;
    }
  }

  get mode() {
    return this._mode;
  }

  /** Estimated tempo from lyrics (0 when unknown). */
  get lyricsBpm() {
    return this._lyricsBpm;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Turn the reactive source on. Resolves to the resulting mode ('audio' | 'lyrics').
   * Falls back to 'lyrics' when the bridge is missing, permission is denied/times out, or native start fails.
   * Once 'audio' is returned, a watchdog still falls back to 'lyrics' (and fires onModeChange) if frames are
   * silent / absent for >3s while playing, and recovers to 'audio' if real frames appear later.
   */
  async enable({ requestPermission = true } = {}) {
    const id = ++this._enableId;
    try {
      this._teardownAudio();
      if (!AudioReactive.isNativeAvailable(this._bridge)) {
        this._setMode(MODE_LYRICS);
        return this._mode;
      }
      const granted = await this._ensurePermission(requestPermission !== false);
      if (id !== this._enableId) return this._mode; // superseded by disable()/enable()
      if (!granted) {
        this._setMode(MODE_LYRICS);
        return this._mode;
      }
      this._installFrameHandler();
      let started = false;
      try { started = this._bridge.startAudioReactive() === true; } catch { started = false; }
      if (!started) {
        this._removeFrameHandler();
        this._setMode(MODE_LYRICS);
        return this._mode;
      }
      const t = this._now();
      this._started = true;
      this._audioWanted = true;
      this._healthSince = t;
      this._lastGoodAt = -Infinity;
      this._goodStreak = 0;
      this._lastGetAt = t;
      this._resetAudioState();
      this._setMode(MODE_AUDIO);
      this._armHealthTimer();
      return this._mode;
    } catch {
      this._teardownAudio();
      this._setMode(MODE_LYRICS);
      return this._mode;
    }
  }

  /** Stop everything; mode becomes 'off' and getFrame() returns zeros. Safe to call repeatedly. */
  disable() {
    this._enableId++;
    this._teardownAudio();
    this._setMode(MODE_OFF);
  }

  setLyrics(syncedLines) {
    try {
      const lines = sanitizeLines(syncedLines);
      this._lines = lines;
      const n = lines.length;
      this._lt = new Array(n);
      this._wc = new Array(n);
      this._dur = new Array(n);
      this._beatEnd = new Array(n);
      for (let i = 0; i < n; i++) {
        const start = lines[i].timeMs;
        const next = i + 1 < n ? lines[i + 1].timeMs : 0;
        const wc = countWords(lines[i].text);
        const timing = computeLineTiming(start, wc, next);
        this._lt[i] = start;
        this._wc[i] = wc;
        this._dur[i] = timing.durationMs;
        this._beatEnd[i] = next > start ? Math.min(next - start, MAX_BEAT_REGION_MS) : timing.durationMs;
      }
      this._idxHint = 0;
      this._lyricsBpm = estimateTempo(lines);
    } catch {
      this._lines = []; this._lt = []; this._wc = []; this._dur = []; this._beatEnd = [];
      this._lyricsBpm = 0;
    }
  }

  /**
   * Optional: the reel can tell us its active line. Only used when no synced lyrics were set
   * (with lyrics, the line is derived from positionMs so the result stays seek-deterministic).
   */
  setActiveLine(line, nextLineTimeMs = 0) {
    try {
      if (!line || typeof line.timeMs !== 'number') { this._ovr = null; return; }
      const wc = countWords(line.text);
      const t = computeLineTiming(line.timeMs, wc, nextLineTimeMs);
      this._ovr = { start: line.timeMs, wc, dur: t.durationMs };
    } catch {
      this._ovr = null;
    }
  }

  setPlaying(isPlaying) {
    const p = Boolean(isPlaying);
    if (p === this._playing) return;
    this._playing = p;
    this._healthSince = this._now(); // silence is only counted while playing
    this._goodStreak = 0;
  }

  /**
   * Current reactive frame for the given playback position.
   * @returns {{energy:number,beat:number,vocal:number,bpm:number,mode:string}} energy/beat/vocal in 0..1
   */
  getFrame(positionMs) {
    try {
      if (this._mode === MODE_OFF) return { energy: 0, beat: 0, vocal: 0, bpm: 0, mode: MODE_OFF };
      const t = this._now();
      const pos = num(positionMs, 0);
      // The rAF loop can pause (hidden tab / backgrounded app): don't blame the stream for that gap.
      if (t - this._lastGetAt > 1000) this._healthSince = t;
      this._checkHealth(t);
      const dt = this._lastGetAt === -Infinity ? 16 : Math.max(0, Math.min(100, t - this._lastGetAt));
      this._lastGetAt = t;
      if (this._mode === MODE_AUDIO) return this._audioFrame(t, dt);
      return this._lyricsFrame(pos);
    } catch {
      return { energy: 0, beat: 0, vocal: 0, bpm: 0, mode: this._mode };
    }
  }

  // ---------------------------------------------------------------- permission + native plumbing

  _ensurePermission(requestPermission) {
    const b = this._bridge;
    let has = false;
    try { has = b.hasAudioPermission() === true; } catch { has = false; }
    if (has) return Promise.resolve(true);
    if (!requestPermission) return Promise.resolve(false);

    return new Promise((resolve) => {
      const host = getHost();
      const prev = host.__lyricwaveAudioPermission;
      let done = false;
      let timer = null;
      const finish = (granted) => {
        if (done) return;
        done = true;
        if (timer !== null) { try { this._timers.clearTimeout(timer); } catch { /* ignore */ } }
        try {
          if (host.__lyricwaveAudioPermission === handler) {
            if (prev === undefined) delete host.__lyricwaveAudioPermission;
            else host.__lyricwaveAudioPermission = prev;
          }
        } catch { /* ignore */ }
        resolve(granted === true);
      };
      const handler = (granted) => {
        try { if (typeof prev === 'function') prev(granted); } catch { /* ignore */ }
        finish(granted === true || granted === 'true');
      };
      try {
        host.__lyricwaveAudioPermission = handler;
        timer = this._timers.setTimeout(() => {
          // timed out: last chance - the permission may have been granted without the callback reaching us
          let nowHas = false;
          try { nowHas = b.hasAudioPermission() === true; } catch { nowHas = false; }
          finish(nowHas);
        }, this._permissionTimeoutMs);
        b.requestAudioPermission();
      } catch {
        finish(false);
      }
    });
  }

  _installFrameHandler() {
    this._removeFrameHandler();
    const host = getHost();
    const prev = host.__lyricwaveAudioFrame;
    const handler = (frame) => {
      if (this._frameHandler === handler) this._onFrame(frame);
      try { if (typeof prev === 'function') prev(frame); } catch { /* ignore */ }
    };
    this._frameHost = host;
    this._prevFrameHandler = prev;
    this._frameHandler = handler;
    host.__lyricwaveAudioFrame = handler;
  }

  _removeFrameHandler() {
    const host = this._frameHost;
    const handler = this._frameHandler;
    this._frameHandler = null; // makes a chained-over handler inert (it only forwards to prev)
    this._frameHost = null;
    if (!host || !handler) return;
    try {
      if (host.__lyricwaveAudioFrame === handler) {
        if (this._prevFrameHandler === undefined) delete host.__lyricwaveAudioFrame;
        else host.__lyricwaveAudioFrame = this._prevFrameHandler;
      }
    } catch { /* ignore */ }
    this._prevFrameHandler = undefined;
  }

  _teardownAudio() {
    if (this._healthTimer !== null) {
      try { this._timers.clearTimeout(this._healthTimer); } catch { /* ignore */ }
      this._healthTimer = null;
    }
    this._removeFrameHandler();
    if (this._started) {
      try { this._bridge && this._bridge.stopAudioReactive(); } catch { /* ignore */ }
    }
    this._started = false;
    this._audioWanted = false;
    this._resetAudioState();
  }

  _resetAudioState() {
    const g = this._tgt;
    g.rms = g.bass = g.mid = g.vocal = g.high = g.bpm = 0;
    this._sm.energy = 0;
    this._sm.vocal = 0;
    this._bpmSm = 0;
    this._beatPeak = 0;
    this._beatAt = -Infinity;
    this._frameAt = -Infinity;
    this._goodStreak = 0;
  }

  _armHealthTimer() {
    if (this._healthTimer !== null) return;
    try {
      const timer = this._timers.setTimeout(() => {
        this._healthTimer = null;
        if (!this._audioWanted) return;
        this._checkHealth(this._now());
        this._armHealthTimer();
      }, 1000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._healthTimer = timer;
    } catch { /* ignore */ }
  }

  _checkHealth(t) {
    if (!this._audioWanted || this._mode !== MODE_AUDIO) return;
    if (!this._playing) { this._healthSince = t; return; }
    const lastOk = Math.max(this._lastGoodAt, this._healthSince);
    if (t - lastOk > SILENCE_TIMEOUT_MS) this._setMode(MODE_LYRICS);
  }

  _onFrame(f) {
    if (!f || typeof f !== 'object') return;
    const t = this._now();
    this._frameAt = t;
    const g = this._tgt;
    g.rms = clamp01(num(f.rms));
    g.bass = clamp01(num(f.bass));
    g.mid = clamp01(num(f.mid));
    g.vocal = clamp01(num(f.vocal));
    g.high = clamp01(num(f.high));
    g.bpm = Math.max(0, num(f.bpm));

    if (f.silent === true) {
      this._goodStreak = 0;
      return;
    }
    this._lastGoodAt = t;
    this._goodStreak++;
    if (this._mode === MODE_LYRICS && this._audioWanted && this._goodStreak >= RECOVER_STREAK) {
      this._healthSince = t;
      this._setMode(MODE_AUDIO);
    }
    if (f.beat === true && this._playing && t - this._beatAt >= MIN_BEAT_GAP_MS) {
      const s = num(f.beatStrength, 1);
      this._beatPeak = s > 0 ? Math.min(1, s) : 1;
      this._beatAt = t;
    }
  }

  _setMode(m) {
    if (m === this._mode) return;
    this._mode = m;
    try { this.onModeChange(m); } catch { /* listener errors must never break the loop */ }
  }

  // ---------------------------------------------------------------- audio mode frame

  _audioFrame(t, dt) {
    const g = this._tgt;
    const sm = this._sm;
    const live = this._playing && t - this._frameAt <= FRAME_HOLD_MS;
    const tEnergy = live ? clamp01(0.65 * g.rms + 0.35 * g.bass) : 0;
    const tVocal = live ? g.vocal : 0;

    sm.energy = smoothToward(sm.energy, tEnergy, dt);
    sm.vocal = smoothToward(sm.vocal, tVocal, dt);

    // bpm: slow follow of native estimate; fall back to the lyric-derived tempo when native has none
    const tBpm = g.bpm > 0 ? g.bpm : this._lyricsBpm;
    if (tBpm > 0) this._bpmSm = this._bpmSm > 0 ? this._bpmSm + (tBpm - this._bpmSm) * Math.min(1, dt / 1000) : tBpm;
    else this._bpmSm = 0;

    const age = t - this._beatAt;
    const beat = age >= 0 && age < BEAT_DECAY_MS ? this._beatPeak * (1 - age / BEAT_DECAY_MS) : 0;

    return { energy: sm.energy, beat, vocal: sm.vocal, bpm: this._bpmSm, mode: MODE_AUDIO };
  }

  // ---------------------------------------------------------------- lyrics mode frame (pure)

  _findLine(pos) {
    const t = this._lt;
    const n = t.length;
    if (n === 0 || pos < t[0]) return -1;
    let i = this._idxHint;
    if (i < n && t[i] <= pos && (i + 1 >= n || pos < t[i + 1])) return i;
    if (i + 1 < n && t[i + 1] <= pos && (i + 2 >= n || pos < t[i + 2])) { this._idxHint = i + 1; return i + 1; }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    this._idxHint = lo;
    return lo;
  }

  _lyricsFrame(pos) {
    const bpm = this._lyricsBpm;
    if (!this._playing) return { energy: 0, beat: 0, vocal: 0, bpm, mode: MODE_LYRICS };

    let start;
    let wc;
    let dur;
    let beatEnd;
    let lineDur = 0;       // real distance to the next line (0 = unknown)
    let lineIdx = 0;
    const idx = this._findLine(pos);
    if (this._lt.length > 0) {
      if (idx < 0) return { energy: 0, beat: 0, vocal: 0, bpm, mode: MODE_LYRICS };
      start = this._lt[idx];
      wc = this._wc[idx];
      dur = this._dur[idx];
      beatEnd = this._beatEnd[idx];
      lineIdx = idx;
      if (idx + 1 < this._lt.length) lineDur = this._lt[idx + 1] - start;
    } else if (this._ovr && pos >= this._ovr.start) {
      start = this._ovr.start;
      wc = this._ovr.wc;
      dur = this._ovr.dur;
      beatEnd = dur;
    } else {
      return { energy: 0, beat: 0, vocal: 0, bpm, mode: MODE_LYRICS };
    }

    const offset = pos - start;
    let vocal = 0;
    let beat = 0;

    if (wc <= 0) {
      // empty line / instrumental marker: let the vocal fade out quickly, no beat grid
      vocal = offset < 250 ? 0.3 * (1 - offset / 250) : 0;
    } else {
      if (offset <= dur) {
        const iv = dur / wc;
        let k = Math.floor(offset / iv);
        if (k > wc - 1) k = wc - 1;
        const age = offset - k * iv;
        // deterministic per-word accent so it feels organic but never random
        const amp = 0.7 + 0.3 * (((k * 7 + lineIdx * 3) % 5) / 4);
        // onset bump: ~50ms attack, ~140ms exponential release, on top of a gentle sustain
        const bump = age < 50 ? age / 50 : Math.exp(-(age - 50) / 140);
        vocal = 0.3 + 0.55 * amp * bump;
      } else {
        const tail = 1 - (offset - dur) / RELEASE_MS;
        vocal = tail > 0 ? 0.3 * tail : 0;
      }

      if (bpm > 0 && offset <= beatEnd) {
        const P = 60000 / bpm;
        let period = P;
        if (lineDur > 0 && lineDur <= MAX_BEAT_REGION_MS) {
          // snap the grid so a whole number of beats fits between this line start and the next
          const n = Math.max(1, Math.round(lineDur / P));
          const snapped = lineDur / n;
          if (Math.abs(snapped / P - 1) <= 0.2) period = snapped;
        }
        const bi = Math.floor(offset / period);
        const beatAge = offset - bi * period;
        if (beatAge < BEAT_DECAY_MS) {
          const strength = bi % 4 === 0 ? 0.85 : bi % 2 === 0 ? 0.65 : 0.5;
          beat = strength * (1 - beatAge / BEAT_DECAY_MS);
        }
      }
    }

    const energy = clamp01(0.85 * vocal + 0.25 * beat);
    return { energy, beat: clamp01(beat), vocal: clamp01(vocal), bpm, mode: MODE_LYRICS };
  }
}

AudioReactive.estimateTempo = estimateTempo;

function smoothToward(cur, target, dtMs) {
  const tau = target > cur ? ATTACK_MS : RELEASE_MS;
  return cur + (target - cur) * (1 - Math.exp(-dtMs / tau));
}

export default AudioReactive;
