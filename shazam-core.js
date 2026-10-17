/**
 * LyricWave Shazam core — shared by the browser, the desktop app and the Pages Function.
 *
 *  - Acoustic fingerprint generator: a byte-exact port of the SongRec / shazamio algorithm
 *    (STFT landmark peaks -> `data:audio/vnd.shazam.sig;base64,...`). It runs in the browser,
 *    so the server never has to burn CPU on FFTs (a Cloudflare Worker gets ~10 ms of CPU; the
 *    old server-side generator needed ~300 ms and the platform answered HTTP 503).
 *  - Request builder and response normaliser for Shazam's discovery ("tag") endpoint, so every
 *    caller (Worker, Electron main process, tests) talks to Shazam the same way.
 *
 * Zero dependencies, no DOM access, no allocation inside the per-frame loops.
 */

export const DATA_URI_PREFIX = 'data:audio/vnd.shazam.sig;base64,';
export const SAMPLE_RATE = 16000;
/** Shazam matches best on 3-12 s of audio; longer input is trimmed to its newest 12 s. */
export const MAX_SIGNATURE_SECONDS = 12;

const FFT_SIZE = 2048;
const HOP = 128;
const BINS = FFT_SIZE / 2 + 1; // 1025
const RING = 256;

export const FrequencyBand = {
  _250_520: 0,
  _520_1450: 1,
  _1450_3500: 2,
  _3500_5500: 3
};
const BAND_NAMES = ['_250_520', '_520_1450', '_1450_3500', '_3500_5500'];

// numpy.hanning(2050)[1:-1]
export const HANNING_MATRIX = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANNING_MATRIX[i] = 0.5 * (1 - Math.cos((2 * Math.PI * (i + 1)) / (FFT_SIZE + 1)));
}

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3), used by the signature header
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes, start = 0, end = bytes.length) {
  let crc = -1;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// Real FFT of size 2048 via a 1024-point complex FFT + split step.
// Output: power spectrum |X[k]|^2 for k = 0..1024.
// ---------------------------------------------------------------------------

const HALF = FFT_SIZE / 2; // 1024
const LOG2_HALF = 10;
const BITREV = new Uint16Array(HALF);
for (let i = 0; i < HALF; i++) {
  let r = 0;
  for (let b = 0; b < LOG2_HALF; b++) r |= ((i >>> b) & 1) << (LOG2_HALF - 1 - b);
  BITREV[i] = r;
}
const TW_COS = new Float64Array(HALF / 2); // twiddles of the 1024-point FFT
const TW_SIN = new Float64Array(HALF / 2);
for (let i = 0; i < HALF / 2; i++) {
  TW_COS[i] = Math.cos((-2 * Math.PI * i) / HALF);
  TW_SIN[i] = Math.sin((-2 * Math.PI * i) / HALF);
}
const SPLIT_COS = new Float64Array(HALF); // twiddles of the real/complex split
const SPLIT_SIN = new Float64Array(HALF);
for (let k = 0; k < HALF; k++) {
  SPLIT_COS[k] = Math.cos((-2 * Math.PI * k) / FFT_SIZE);
  SPLIT_SIN[k] = Math.sin((-2 * Math.PI * k) / FFT_SIZE);
}

const fftRe = new Float64Array(HALF);
const fftIm = new Float64Array(HALF);

/**
 * @param {Float64Array} input 2048 real samples
 * @param {Float64Array} power 1025 outputs (|X|^2)
 */
export function realFftPower(input, power) {
  for (let i = 0; i < HALF; i++) {
    const j = BITREV[i];
    fftRe[j] = input[2 * i];
    fftIm[j] = input[2 * i + 1];
  }
  for (let size = 2; size <= HALF; size <<= 1) {
    const half = size >>> 1;
    const step = HALF / size;
    for (let start = 0; start < HALF; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = TW_COS[k * step];
        const wi = TW_SIN[k * step];
        const a = start + k;
        const b = a + half;
        const xr = fftRe[b] * wr - fftIm[b] * wi;
        const xi = fftRe[b] * wi + fftIm[b] * wr;
        fftRe[b] = fftRe[a] - xr;
        fftIm[b] = fftIm[a] - xi;
        fftRe[a] += xr;
        fftIm[a] += xi;
      }
    }
  }
  // X[k] = (Z[k] + conj(Z[N/2-k]))/2 + W^k (Z[k] - conj(Z[N/2-k])) / (2i)
  power[0] = (fftRe[0] + fftIm[0]) ** 2;
  power[HALF] = (fftRe[0] - fftIm[0]) ** 2;
  for (let k = 1; k < HALF; k++) {
    const zr = fftRe[k], zi = fftIm[k];
    const cr = fftRe[HALF - k], ci = -fftIm[HALF - k];
    const er = (zr + cr) / 2, ei = (zi + ci) / 2;   // even part
    const or = (zi - ci) / 2, oi = -(zr - cr) / 2;  // odd part ( (Z - conj) / 2i )
    const wr = SPLIT_COS[k], wi = SPLIT_SIN[k];
    const xr = er + (or * wr - oi * wi);
    const xi = ei + (or * wi + oi * wr);
    power[k] = xr * xr + xi * xi;
  }
}

// ---------------------------------------------------------------------------
// Signature container
// ---------------------------------------------------------------------------

export class FrequencyPeak {
  constructor(fftPassNumber, peakMagnitude, correctedPeakFrequencyBin, sampleRateHz = SAMPLE_RATE) {
    this.fftPassNumber = fftPassNumber;
    this.peakMagnitude = peakMagnitude;
    this.correctedPeakFrequencyBin = correctedPeakFrequencyBin;
    this.sampleRateHz = sampleRateHz;
  }

  getFrequencyHz() {
    return this.correctedPeakFrequencyBin * (this.sampleRateHz / 2 / 1024 / 64);
  }

  getSeconds() {
    return (this.fftPassNumber * HOP) / this.sampleRateHz;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export class DecodedMessage {
  constructor() {
    this.sampleRateHz = SAMPLE_RATE;
    this.numberSamples = 0;
    /** @type {Record<string, FrequencyPeak[]>} band name -> peaks (ascending fftPassNumber) */
    this.frequencyBandToSoundPeaks = {};
  }

  peakCount() {
    let n = 0;
    for (const peaks of Object.values(this.frequencyBandToSoundPeaks)) n += peaks.length;
    return n;
  }

  encodeToBinary() {
    // Band chunks, in ascending band order
    const chunks = [];
    let contentsLength = 0;
    for (let band = 0; band < BAND_NAMES.length; band++) {
      const peaks = this.frequencyBandToSoundPeaks[BAND_NAMES[band]];
      if (!peaks || peaks.length === 0) continue;
      const body = [];
      let pass = 0;
      for (const p of peaks) {
        if (p.fftPassNumber - pass >= 255) {
          body.push(0xff, p.fftPassNumber & 0xff, (p.fftPassNumber >>> 8) & 0xff, (p.fftPassNumber >>> 16) & 0xff, (p.fftPassNumber >>> 24) & 0xff);
          pass = p.fftPassNumber;
        }
        const mag = p.peakMagnitude & 0xffff;
        const bin = p.correctedPeakFrequencyBin & 0xffff;
        body.push(p.fftPassNumber - pass, mag & 0xff, mag >>> 8, bin & 0xff, bin >>> 8);
        pass = p.fftPassNumber;
      }
      const padded = body.length + ((4 - (body.length % 4)) % 4);
      chunks.push({ band, body, padded });
      contentsLength += 8 + padded;
    }

    const out = new Uint8Array(48 + 8 + contentsLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0xcafe2580, true);
    dv.setUint32(8, contentsLength + 8, true);
    dv.setUint32(12, 0x94119c00, true);
    dv.setUint32(28, (3 << 27) >>> 0, true); // sample rate id 3 = 16 kHz
    dv.setUint32(40, Math.trunc(this.numberSamples + this.sampleRateHz * 0.24), true);
    dv.setUint32(44, (15 << 19) + 0x40000, true);
    dv.setUint32(48, 0x40000000, true);
    dv.setUint32(52, contentsLength + 8, true);
    let ptr = 56;
    for (const { band, body, padded } of chunks) {
      dv.setUint32(ptr, 0x60030040 + band, true);
      dv.setUint32(ptr + 4, body.length, true);
      out.set(body, ptr + 8);
      ptr += 8 + padded;
    }
    dv.setUint32(4, crc32(out, 8), true);
    return out;
  }

  encodeToUri() {
    return DATA_URI_PREFIX + bytesToBase64(this.encodeToBinary());
  }

  static decodeFromBinary(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0xcafe2580 || dv.getUint32(12, true) !== 0x94119c00) {
      throw new Error('Invalid Shazam signature magic bytes.');
    }
    if (crc32(bytes, 8) !== dv.getUint32(4, true)) {
      throw new Error('Shazam signature CRC mismatch.');
    }
    const self = new DecodedMessage();
    self.numberSamples = Math.round(dv.getUint32(40, true) - self.sampleRateHz * 0.24);

    let ptr = 56; // 48-byte header + 8-byte 0x40000000 wrapper
    while (ptr + 8 <= bytes.length) {
      const band = dv.getInt32(ptr, true) - 0x60030040;
      const size = dv.getInt32(ptr + 4, true);
      ptr += 8;
      const name = BAND_NAMES[band] || `band_${band}`;
      const peaks = (self.frequencyBandToSoundPeaks[name] = []);
      const end = Math.min(bytes.length, ptr + size);
      let pass = 0;
      while (ptr < end) {
        const delta = bytes[ptr++];
        if (delta === 0xff) {
          pass = dv.getUint32(ptr, true);
          ptr += 4;
          continue; // the next byte is the regular (zero) delta of this peak
        }
        pass += delta;
        if (ptr + 4 > end) break;
        peaks.push(new FrequencyPeak(pass, dv.getUint16(ptr, true), dv.getUint16(ptr + 2, true), self.sampleRateHz));
        ptr += 4;
      }
      ptr = end + ((4 - (size % 4)) % 4);
    }
    return self;
  }

  static decodeFromUri(uri) {
    if (!uri || !uri.startsWith(DATA_URI_PREFIX)) throw new Error('Invalid Shazam signature URI prefix.');
    const bin = atob(uri.slice(DATA_URI_PREFIX.length));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return DecodedMessage.decodeFromBinary(bytes);
  }
}

// ---------------------------------------------------------------------------
// Signature generator (SongRec algorithm)
// ---------------------------------------------------------------------------

const LOG_SCALE = 1477.3;
const LOG_OFFSET = 6144;
const MIN_POWER = 1 / 64;
const NEIGHBORS_SAME_FFT = [-10, -7, -4, -3, 1, 2, 5, 8];
const NEIGHBORS_OTHER_FFTS = [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249];

export class SignatureGenerator {
  constructor() {
    this.samples = new Float64Array(FFT_SIZE);
    this.windowed = new Float64Array(FFT_SIZE);
    this.fftOutputs = Array.from({ length: RING }, () => new Float64Array(BINS));
    this.spreadOutputs = Array.from({ length: RING }, () => new Float64Array(BINS));
    this.reset();
  }

  reset() {
    this.samples.fill(0);
    this.samplePos = 0;
    for (const a of this.fftOutputs) a.fill(0);
    for (const a of this.spreadOutputs) a.fill(0);
    this.fftPos = 0;
    this.spreadPos = 0;
    this.spreadWritten = 0;
    this.signature = new DecodedMessage();
  }

  /**
   * Fingerprint signed 16-bit, 16 kHz mono samples. Input longer than 12 s is trimmed to its
   * newest 12 s; only whole 128-sample hops are processed (as the reference does).
   * @param {Int16Array|ArrayLike<number>} samples
   * @returns {DecodedMessage}
   */
  getSignature(samples) {
    this.reset();
    const max = MAX_SIGNATURE_SECONDS * SAMPLE_RATE;
    const start = samples.length > max ? samples.length - max : 0;
    const usable = Math.floor((samples.length - start) / HOP) * HOP;
    for (let off = start; off < start + usable; off += HOP) {
      this.signature.numberSamples += HOP;
      this.doFFT(samples, off);
      this.doPeakSpreading();
      if (this.spreadWritten >= 46) this.doPeakRecognition();
    }
    return this.signature;
  }

  doFFT(samples, off) {
    const ring = this.samples;
    for (let i = 0; i < HOP; i++) ring[(this.samplePos + i) & (FFT_SIZE - 1)] = samples[off + i];
    this.samplePos = (this.samplePos + HOP) & (FFT_SIZE - 1);
    const w = this.windowed;
    for (let i = 0; i < FFT_SIZE; i++) w[i] = ring[(this.samplePos + i) & (FFT_SIZE - 1)] * HANNING_MATRIX[i];

    const out = this.fftOutputs[this.fftPos];
    realFftPower(w, out);
    for (let i = 0; i < BINS; i++) {
      const e = out[i] / (1 << 17);
      out[i] = e > 1e-10 ? e : 1e-10;
    }
    this.fftPos = (this.fftPos + 1) % RING;
  }

  doPeakSpreading() {
    const origin = this.fftOutputs[(this.fftPos - 1 + RING) % RING];
    const spread = this.spreadOutputs[this.spreadPos];
    // Frequency-domain spreading: max over [p, p+2], last three bins untouched.
    for (let p = 0; p < BINS - 3; p++) {
      let m = origin[p];
      if (origin[p + 1] > m) m = origin[p + 1];
      if (origin[p + 2] > m) m = origin[p + 2];
      spread[p] = m;
    }
    for (let p = BINS - 3; p < BINS; p++) spread[p] = origin[p];

    // Time-domain spreading into the -1, -3, -6 frames, cascading the running max.
    const f1 = this.spreadOutputs[(this.spreadPos - 1 + RING) % RING];
    const f3 = this.spreadOutputs[(this.spreadPos - 3 + RING) % RING];
    const f6 = this.spreadOutputs[(this.spreadPos - 6 + RING) % RING];
    for (let p = 0; p < BINS; p++) {
      let m = spread[p];
      if (f1[p] > m) m = f1[p];
      f1[p] = m;
      if (f3[p] > m) m = f3[p];
      f3[p] = m;
      if (f6[p] > m) m = f6[p];
      f6[p] = m;
    }
    this.spreadPos = (this.spreadPos + 1) % RING;
    this.spreadWritten++;
  }

  doPeakRecognition() {
    const fft46 = this.fftOutputs[(this.fftPos - 46 + RING) % RING];
    const spread49 = this.spreadOutputs[(this.spreadPos - 49 + RING) % RING];
    const fftNumber = this.spreadWritten - 46;
    const bands = this.signature.frequencyBandToSoundPeaks;

    for (let bin = 10; bin <= 1014; bin++) {
      const v = fft46[bin];
      if (v < MIN_POWER || v < spread49[bin - 1]) continue;

      let maxNeighbor = 0;
      for (let i = 0; i < NEIGHBORS_SAME_FFT.length; i++) {
        const c = spread49[bin + NEIGHBORS_SAME_FFT[i]];
        if (c > maxNeighbor) maxNeighbor = c;
      }
      if (!(v > maxNeighbor)) continue;

      let maxOther = maxNeighbor;
      for (let i = 0; i < NEIGHBORS_OTHER_FFTS.length; i++) {
        const c = this.spreadOutputs[(this.spreadPos + NEIGHBORS_OTHER_FFTS[i] + RING) % RING][bin - 1];
        if (c > maxOther) maxOther = c;
      }
      if (!(v > maxOther)) continue;

      const mag = Math.log(Math.max(MIN_POWER, v)) * LOG_SCALE + LOG_OFFSET;
      const before = Math.log(Math.max(MIN_POWER, fft46[bin - 1])) * LOG_SCALE + LOG_OFFSET;
      const after = Math.log(Math.max(MIN_POWER, fft46[bin + 1])) * LOG_SCALE + LOG_OFFSET;
      const var1 = mag * 2 - before - after;
      if (!(var1 > 0)) continue;
      const corrected = bin * 64 + ((after - before) * 32) / var1;
      const hz = corrected * (SAMPLE_RATE / 2 / 1024 / 64);

      let name;
      if (hz > 250 && hz < 520) name = '_250_520';
      else if (hz > 520 && hz < 1450) name = '_520_1450';
      else if (hz > 1450 && hz < 3500) name = '_1450_3500';
      else if (hz > 3500 && hz <= 5500) name = '_3500_5500';
      else continue;

      (bands[name] || (bands[name] = [])).push(
        new FrequencyPeak(fftNumber, Math.trunc(mag), Math.trunc(corrected), SAMPLE_RATE)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Float samples (-1..1) -> signed 16-bit. */
export function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = float32[i] > 1 ? 1 : float32[i] < -1 ? -1 : float32[i];
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Resample mono float audio to 16 kHz with a windowed-sinc low-pass (no aliasing of the
 * 8 kHz+ content that microphones pick up). Used where OfflineAudioContext is unavailable.
 * @param {Float32Array} input
 * @param {number} inputRate
 * @returns {Float32Array}
 */
export function resampleTo16k(input, inputRate) {
  if (!input || input.length === 0) return new Float32Array(0);
  if (inputRate === SAMPLE_RATE) return Float32Array.from(input);
  const ratio = inputRate / SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  const cutoff = Math.min(1, 1 / ratio) * 0.95; // normalised to the input Nyquist
  const halfTaps = 16;
  const radius = Math.ceil(halfTaps * Math.max(1, ratio));
  for (let i = 0; i < outLength; i++) {
    const center = i * ratio;
    const first = Math.max(0, Math.ceil(center - radius));
    const last = Math.min(input.length - 1, Math.floor(center + radius));
    let acc = 0;
    let norm = 0;
    for (let j = first; j <= last; j++) {
      const x = j - center;
      const t = x * cutoff;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / (radius + 1)); // Hann
      const k = sinc * win;
      acc += input[j] * k;
      norm += k;
    }
    out[i] = norm ? acc / norm : 0;
  }
  return out;
}

/**
 * Parse a WAV container (PCM 8/16/32-bit int or 32-bit float, any channel count / rate) or raw
 * 16-bit little-endian PCM into 16 kHz signed 16-bit mono samples.
 * @param {Uint8Array|ArrayBuffer} buffer
 * @returns {Int16Array|null}
 */
export function parseWavTo16kSamples(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!bytes || bytes.length === 0) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isRiff = bytes.length >= 12 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF' &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WAVE';

  if (!isRiff) {
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'data') return null; // a data: URI
    const n = Math.floor(bytes.length / 2);
    const s16 = new Int16Array(n);
    for (let i = 0; i < n; i++) s16[i] = dv.getInt16(i * 2, true);
    return s16;
  }

  let offset = 12;
  let channels = 1, rate = SAMPLE_RATE, bits = 16, format = 1;
  let dataOffset = -1, dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = dv.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      format = dv.getUint16(offset + 8, true);
      channels = dv.getUint16(offset + 10, true) || 1;
      rate = dv.getUint32(offset + 12, true) || SAMPLE_RATE;
      bits = dv.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(size, bytes.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0 || dataSize <= 0) return null;

  const bps = bits / 8;
  const frames = Math.floor(dataSize / (channels * bps));
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataOffset + (f * channels + c) * bps;
      if (bits === 16) sum += dv.getInt16(o, true) / 32768;
      else if (bits === 8) sum += (bytes[o] - 128) / 128;
      else if (bits === 32) sum += format === 3 ? dv.getFloat32(o, true) : dv.getInt32(o, true) / 2147483648;
      else if (bits === 24) sum += ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8 >> 8) / 8388608;
    }
    mono[f] = sum / channels;
  }
  return floatToInt16(resampleTo16k(mono, rate));
}

/** 16 kHz 16-bit mono WAV from Int16Array or Float32Array samples. */
export function encode16kWav(samples) {
  const byteLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + byteLength, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, byteLength, true);
  const isFloat = samples instanceof Float32Array || samples instanceof Float64Array;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (isFloat) {
      const c = s > 1 ? 1 : s < -1 ? -1 : s;
      s = c < 0 ? c * 0x8000 : c * 0x7fff;
    }
    view.setInt16(44 + i * 2, s, true);
  }
  return new Uint8Array(buffer);
}

/**
 * Fingerprint 16 kHz signed 16-bit mono PCM.
 * @param {Int16Array} samples
 * @returns {{ uri: string, samplems: number, peaks: number }}
 */
export function createSignatureFromPcm(samples) {
  const sig = new SignatureGenerator().getSignature(samples);
  return {
    uri: sig.encodeToUri(),
    samplems: Math.trunc((sig.numberSamples / SAMPLE_RATE) * 1000),
    peaks: sig.peakCount()
  };
}

/**
 * `{ uri, samplems }` from any input: a signature data URI (string or bytes), a WAV file or
 * raw 16-bit PCM.
 */
export function generateShazamSignature(input) {
  if (typeof input === 'string' && input.startsWith(DATA_URI_PREFIX)) {
    return { uri: input, samplems: samplemsFromUri(input) };
  }
  const bytes = input instanceof Uint8Array ? input
    : typeof input === 'string' ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  if (bytes.length > DATA_URI_PREFIX.length && bytes[0] === 0x64 && bytes[1] === 0x61 && bytes[2] === 0x74 && bytes[3] === 0x61) {
    const str = new TextDecoder().decode(bytes).trim();
    if (str.startsWith(DATA_URI_PREFIX)) return { uri: str, samplems: samplemsFromUri(str) };
  }
  const samples = parseWavTo16kSamples(bytes);
  if (!samples || samples.length === 0) {
    throw new Error('Unable to parse audio samples for Shazam fingerprint generation.');
  }
  const { uri, samplems } = createSignatureFromPcm(samples);
  return { uri, samplems };
}

/** Sample length (ms) stored inside a signature, or 8000 when it cannot be read. */
export function samplemsFromUri(uri) {
  try {
    const sig = DecodedMessage.decodeFromUri(uri);
    return Math.max(0, Math.trunc((sig.numberSamples / SAMPLE_RATE) * 1000));
  } catch {
    return 8000;
  }
}

/** True for a well-formed signature data URI (magic + CRC check). */
export function isValidSignatureUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(DATA_URI_PREFIX) || uri.length > 200000) return false;
  try {
    DecodedMessage.decodeFromUri(uri);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shazam discovery API
// ---------------------------------------------------------------------------

export const SHAZAM_ENDPOINT = 'https://amp.shazam.com';

const SHAZAM_USER_AGENTS = [
  'Dalvik/2.1.0 (Linux; U; Android 10; SM-G973F Build/QP1A.190711.020)',
  'Dalvik/2.1.0 (Linux; U; Android 11; Pixel 5 Build/RD1A.201105.003)',
  'Dalvik/2.1.0 (Linux; U; Android 12; Pixel 6 Build/SQ1D.211205.016.A1)',
  'Dalvik/2.1.0 (Linux; U; Android 13; SM-S901B Build/TP1A.220624.014)',
  'Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Build/UD1A.230803.041)'
];

function uuidUpper() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().toUpperCase();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }).toUpperCase();
}

/**
 * Build the HTTP request for Shazam's tag endpoint.
 * @param {{uri:string, samplems:number}} signature
 * @param {{endpoint?:string, timezone?:string, language?:string, country?:string}} [opts]
 * @returns {{ url: string, init: { method: string, headers: Record<string,string>, body: string } }}
 */
export function buildShazamRequest(signature, opts = {}) {
  const endpoint = String(opts.endpoint || SHAZAM_ENDPOINT).replace(/\/+$/, '');
  const language = opts.language || 'en';
  const country = opts.country || 'US';
  const query = 'sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3';
  const url = `${endpoint}/discovery/v5/${language}/${country}/android/-/tag/${uuidUpper()}/${uuidUpper()}?${query}`;
  const body = JSON.stringify({
    timezone: opts.timezone || 'UTC',
    signature: { uri: signature.uri, samplems: Math.round(signature.samplems) },
    timestamp: Date.now(),
    context: {},
    geolocation: {}
  });
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Language': language,
        'User-Agent': SHAZAM_USER_AGENTS[Math.floor(Math.random() * SHAZAM_USER_AGENTS.length)],
        'X-Shazam-Platform': 'IPHONE',
        'X-Shazam-AppVersion': '14.1.0'
      },
      body
    }
  };
}

function emptyResult(extra = {}) {
  return {
    success: false, title: null, artist: null, album: null, duration: 0,
    offsetMs: null, offsetRef: 'start', confidence: 0, provider: 'shazam', raw: null, ...extra
  };
}

/**
 * Normalise Shazam's JSON into LyricWave's recognition result.
 *
 * `offsetMs` is the song position at the START of the fingerprinted sample (offsetRef: 'start'),
 * unlike ACRCloud's play_offset_ms which points at the end of the sample.
 * `retryMs` is Shazam's hint to try again with more audio after a miss.
 */
export function normalizeShazamResponse(rawData) {
  if (!rawData || typeof rawData !== 'object') return emptyResult();
  const matches = Array.isArray(rawData.matches) ? rawData.matches : [];
  const track = rawData.track;
  if (matches.length === 0 || !track) {
    return emptyResult({ retryMs: Number(rawData.retryms) || null });
  }

  const match = matches[0] || {};
  const title = track.title || 'Unknown Title';
  const artist = track.subtitle || 'Unknown Artist';
  const songMeta = (track.sections || []).find((s) => s && s.type === 'SONG')?.metadata || [];
  const meta = (name) => songMeta.find((m) => m && m.title === name)?.text || null;

  const offsetMs = typeof match.offset === 'number' ? Math.round(match.offset * 1000) : null;
  let confidence = 100;
  if (typeof match.timeskew === 'number') {
    confidence = Math.max(50, Math.min(100, Math.round(100 - Math.abs(match.timeskew) * 1000)));
  }

  let spotifyTrackId = null;
  for (const prov of track.hub?.providers || []) {
    if (prov?.type !== 'SPOTIFY') continue;
    for (const act of prov.actions || []) {
      const m = typeof act?.uri === 'string' && act.uri.match(/spotify:track:([A-Za-z0-9]+)/);
      if (m) spotifyTrackId = m[1];
    }
  }
  let appleMusicId = null;
  for (const act of track.myshazam?.apple?.actions || []) {
    const m = typeof act?.uri === 'string' && act.uri.match(/id=(\d+)/);
    if (m) appleMusicId = m[1];
  }

  const lookupCandidates = [];
  const addCandidate = (t, a) => {
    const ct = String(t || '').trim();
    const ca = String(a || '').trim();
    if (!ct) return;
    const key = `${ct}__${ca}`.toLowerCase();
    if (!lookupCandidates.some((c) => `${c.title}__${c.artist}`.toLowerCase() === key)) {
      lookupCandidates.push({ title: ct, artist: ca, duration: 0 });
    }
  };
  addCandidate(title, artist);
  const cleanTitle = title.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();
  if (cleanTitle && cleanTitle !== title) addCandidate(cleanTitle, artist);
  const primaryArtist = artist.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0];
  if (primaryArtist && primaryArtist !== artist) addCandidate(cleanTitle || title, primaryArtist);

  return {
    success: true,
    title,
    artist,
    album: meta('Album') || '',
    duration: 0,
    offsetMs,
    offsetRef: 'start',
    confidence,
    provider: 'shazam',
    lookupCandidates,
    raw: {
      shazamKey: track.key || null,
      isrc: track.isrc || null,
      genres: track.genres?.primary ? [track.genres.primary] : [],
      releaseDate: meta('Released'),
      label: meta('Label'),
      spotifyTrackId,
      appleMusicId,
      coverArt: track.images?.coverart || track.images?.coverarthq || null
    }
  };
}
