/**
 * LyricWave projectM visualizer
 *
 * The real projectM (libprojectM 4, the open-source MilkDrop engine) compiled to WebAssembly +
 * WebGL 2 (vendor/projectm/, built by scripts/build-projectm.sh). It renders behind the lyrics
 * while the reel is fullscreen.
 *
 * Audio input, best first:
 *   1. live PCM from an AnalyserNode: system audio (desktop app loopback) or the microphone,
 *      when the user turns "React to live audio" on;
 *   2. otherwise a small synth driven by the AudioReactive frame (beat / energy / vocal), so
 *      presets still pulse with the song when no audio can be heard (Spotify, phone source...).
 *
 * The WASM module (~1 MB) and the preset pack load lazily, the first time fullscreen opens.
 * Nothing is recorded: samples go straight from the analyser into projectM's ring buffer.
 */

const MODULE_URL = './vendor/projectm/projectm.js';
const WASM_URL = './vendor/projectm/projectm.wasm';
const PRESETS_URL = './vendor/projectm/presets.json';
const PCM_FRAME = 1024;          // samples handed to projectM per rendered frame (max it keeps is 2048)
const SYNTH_RATE = 44100;
const PRESET_SECONDS = 30;

/**
 * GET a same-origin file as an ArrayBuffer. fetch() first; XHR as the fallback for file:// pages
 * (the desktop app), where Chromium may refuse fetch().
 */
async function loadBinary(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (err) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => (xhr.status === 200 || (xhr.status === 0 && xhr.response) ? resolve(xhr.response) : reject(err));
      xhr.onerror = () => reject(err);
      xhr.send();
    });
  }
}

/** True when this browser can run projectM (WebGL 2 + float colour buffers + WebAssembly). */
export function isProjectMSupported() {
  try {
    if (typeof WebAssembly !== 'object' || typeof document === 'undefined') return false;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ok = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Beat-synth: one block of mono PCM shaped by an AudioReactive frame. Pure apart from `state`
 * (phase accumulators, noise seed), so the waveform is continuous across frames.
 * @param {{beat?:number, energy?:number, vocal?:number}} frame
 * @param {{phase:number[], seed:number, kick:number}} state
 * @param {Float32Array} out
 */
export function synthesizePcm(frame, state, out) {
  const beat = Math.max(0, Math.min(1, Number(frame && frame.beat) || 0));
  const energy = Math.max(0, Math.min(1, Number(frame && frame.energy) || 0));
  const vocal = Math.max(0, Math.min(1, Number(frame && frame.vocal) || 0));
  // A fresh kick drum on each beat rise: decaying 55 Hz sine.
  if (beat > state.kick + 0.25) state.kick = beat;
  const freqs = [55, 220, 330, 440, 880];
  const amps = [0.9 * state.kick, 0.22 * energy, 0.18 * energy, 0.14 * (energy + vocal) * 0.5, 0.1 * vocal];
  const noiseAmp = 0.04 + 0.12 * energy * energy;
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let k = 0; k < freqs.length; k++) {
      state.phase[k] += (2 * Math.PI * freqs[k]) / SYNTH_RATE;
      if (state.phase[k] > 2 * Math.PI) state.phase[k] -= 2 * Math.PI;
      v += Math.sin(state.phase[k]) * amps[k];
    }
    state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
    v += ((state.seed / 4294967296) - 0.5) * noiseAmp;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  state.kick *= 0.82;
  return out;
}

export class ProjectMVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas  dedicated canvas (projectM owns its WebGL 2 context)
   * @param {{ onStatus?: (text:string)=>void, onPresetChange?: (name:string)=>void }} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.onStatus = options.onStatus || (() => {});
    this.onPresetChange = options.onPresetChange || (() => {});
    this.module = null;
    this.loading = null;
    this.failed = false;
    this.active = false;
    this.presets = [];
    this.presetIndex = -1;
    this.analyser = null;
    this.liveStream = null;
    this.liveContext = null;
    this.timeData = new Float32Array(2048);
    this.synthBlock = new Float32Array(PCM_FRAME);
    this.synthState = { phase: [0, 0, 0, 0, 0], seed: 1, kick: 0 };
    this.pcmPtr = 0;
    this.width = 0;
    this.height = 0;
    this.lastFrame = null;
    this.lastLiveAt = 0;
  }

  /** Load the WASM module + presets once. Resolves true when ready. */
  async load() {
    if (this.module) return true;
    if (this.failed) return false;
    if (!this.loading) {
      this.loading = (async () => {
        this.onStatus('Loading projectM…');
        const [{ default: createProjectM }, wasmBinary, presetBytes] = await Promise.all([
          import(MODULE_URL),
          loadBinary(WASM_URL),
          loadBinary(PRESETS_URL)
        ]);
        const pack = JSON.parse(new TextDecoder().decode(presetBytes));
        this.presets = Array.isArray(pack.presets) ? pack.presets.filter((p) => p && p.data) : [];
        if (!this.presets.length) throw new Error('empty preset pack');

        const mod = await createProjectM({
          canvas: this.canvas,
          wasmBinary,
          onPresetSwitchRequested: () => this.nextPreset(true),
          onPresetSwitchFailed: () => this.nextPreset(false),
          print: () => {},
          printErr: () => {}
        });
        this.resize(true);
        if (!this.canvas.id) this.canvas.id = 'projectmCanvas';
        const selector = mod.stringToNewUTF8(`#${this.canvas.id}`);
        const rc = mod._lw_pm_init(selector, this.width, this.height, 48, 32);
        mod._free(selector);
        if (rc !== 0) throw new Error(`projectM init failed (${rc})`);
        mod._lw_pm_set_preset_duration(PRESET_SECONDS);
        this.pcmPtr = mod._malloc(2048 * 4);
        this.module = mod;
        this.presetIndex = Math.floor(Math.random() * this.presets.length) - 1;
        this.nextPreset(false);
        this.onStatus('');
        return true;
      })().catch((err) => {
        console.warn('projectM unavailable:', err);
        this.failed = true;
        this.onStatus('projectM could not start on this device.');
        return false;
      });
    }
    return this.loading;
  }

  async setActive(active) {
    this.active = Boolean(active);
    if (this.active) {
      const ok = await this.load();
      if (ok && this.active) this.resize();
    }
    return this.active && Boolean(this.module);
  }

  get ready() {
    return Boolean(this.module);
  }

  get presetName() {
    return this.presets[this.presetIndex]?.name || '';
  }

  /** Match the drawing buffer to the canvas' CSS size (capped at 1440p for frame rate). */
  resize(force = false) {
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    let w = Math.max(1, Math.round((rect.width || 640) * dpr));
    let h = Math.max(1, Math.round((rect.height || 360) * dpr));
    const scale = Math.min(1, 2560 / w, 1440 / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.module?._lw_pm_resize(w, h);
  }

  nextPreset(smooth = true) {
    if (!this.module || !this.presets.length) return;
    this.presetIndex = (this.presetIndex + 1) % this.presets.length;
    this.loadPreset(this.presetIndex, smooth);
  }

  previousPreset(smooth = true) {
    if (!this.module || !this.presets.length) return;
    this.presetIndex = (this.presetIndex - 1 + this.presets.length) % this.presets.length;
    this.loadPreset(this.presetIndex, smooth);
  }

  loadPreset(index, smooth) {
    const preset = this.presets[index];
    if (!preset) return;
    const ptr = this.module.stringToNewUTF8(preset.data);
    try {
      this.module._lw_pm_load_preset(ptr, smooth ? 1 : 0);
    } finally {
      this.module._free(ptr);
    }
    this.onPresetChange(preset.name);
  }

  /**
   * Feed live audio from a MediaStream (system loopback or microphone). Pass null to go back
   * to the beat-synth.
   */
  setLiveStream(stream) {
    this.releaseLiveStream();
    if (!stream) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.liveContext = new Ctx();
      const src = this.liveContext.createMediaStreamSource(stream);
      this.analyser = this.liveContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      src.connect(this.analyser);
      this.liveStream = stream;
      stream.getTracks().forEach((t) => t.addEventListener('ended', () => {
        if (this.liveStream === stream) this.releaseLiveStream();
      }));
    } catch (err) {
      console.warn('projectM live audio failed:', err);
      this.releaseLiveStream();
    }
  }

  releaseLiveStream() {
    if (this.liveStream) this.liveStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    if (this.liveContext) this.liveContext.close().catch(() => {});
    this.liveStream = null;
    this.liveContext = null;
    this.analyser = null;
  }

  get hasLiveAudio() {
    return Boolean(this.analyser);
  }

  /**
   * Render one frame.
   * @param {{beat?:number, energy?:number, vocal?:number}|null} frame AudioReactive frame (synth input)
   * @param {boolean} playing  pause the synth while the song is paused
   */
  render(frame, playing = true) {
    if (!this.active || !this.module) return;
    this.resize();
    const mod = this.module;
    const heap = mod.HEAPF32;
    const base = this.pcmPtr >> 2;

    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.timeData);
      const n = Math.min(PCM_FRAME, this.timeData.length);
      heap.set(this.timeData.subarray(this.timeData.length - n), base);
      mod._lw_pm_add_pcm(this.pcmPtr, n, 1);
    } else {
      const quiet = { beat: 0, energy: 0, vocal: 0 };
      synthesizePcm(playing ? (frame || quiet) : quiet, this.synthState, this.synthBlock);
      heap.set(this.synthBlock, base);
      mod._lw_pm_add_pcm(this.pcmPtr, this.synthBlock.length, 1);
    }
    mod._lw_pm_render();
  }

  destroy() {
    this.active = false;
    this.releaseLiveStream();
    if (this.module) {
      try {
        this.module._free(this.pcmPtr);
        this.module._lw_pm_destroy();
      } catch {}
    }
    this.module = null;
  }
}
