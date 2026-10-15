/**
 * Shazam Acoustic Fingerprint Signature Generator & Serializer
 * 
 * Implements the Shazam signature container format and STFT landmark
 * peak extractor in pure JavaScript.
 * 
 * Produces valid Base64 data URIs:
 *   data:audio/vnd.shazam.sig;base64,...
 * 
 * Compatible with Apple ShazamKit and Shazam's recognition backend.
 * Zero external dependencies.
 */

import { FFT } from './shazam-fft.js';

// Standard Shazam Hann window matrix (2048 entries)
export const HANNING_MATRIX = new Float32Array(2048);
for (let i = 0; i < 2048; i++) {
  HANNING_MATRIX[i] = 0.5 * (1 - Math.cos((2 * Math.PI * (i + 1)) / 2049));
}

// CRC32 Table (IEEE 802.3)
export const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0 ^ (-1);
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

export const FrequencyBand = {
  _0_250: -1,
  _250_520: 0,
  _520_1450: 1,
  _1450_3500: 2,
  _3500_5500: 3
};

export const FrequencyBandNames = {
  '-1': '_0_250',
  '0': '_250_520',
  '1': '_520_1450',
  '2': '_1450_3500',
  '3': '_3500_5500'
};

export const SampleRateEnum = {
  _8000: 1,
  _11025: 2,
  _16000: 3,
  _32000: 4,
  _44100: 5,
  _48000: 6
};

export const DATA_URI_PREFIX = 'data:audio/vnd.shazam.sig;base64,';

export class FrequencyPeak {
  constructor(fftPassNumber, peakMagnitude, correctedPeakFrequencyBin, sampleRateHz = 16000) {
    this.fftPassNumber = fftPassNumber;
    this.peakMagnitude = peakMagnitude;
    this.correctedPeakFrequencyBin = correctedPeakFrequencyBin;
    this.sampleRateHz = sampleRateHz;
  }

  getFrequencyHz() {
    return this.correctedPeakFrequencyBin * (this.sampleRateHz / 2 / 1024 / 64);
  }

  getSeconds() {
    return (this.fftPassNumber * 128) / this.sampleRateHz;
  }
}

export class RingBuffer {
  constructor(bufferSize, defaultValue) {
    this.bufferSize = bufferSize;
    this.position = 0;
    if (typeof defaultValue === 'function') {
      this.list = Array(bufferSize).fill(null).map(defaultValue);
    } else {
      this.list = Array(bufferSize).fill(defaultValue !== undefined ? defaultValue : null);
    }
  }
}

export const pyMod = (a, b) => ((a % b) >= 0 ? (a % b) : b + (a % b));

function writeInt32LE(val) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, val, true);
  return b;
}

function writeInt16LE(val) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, val, true);
  return b;
}

export class DecodedMessage {
  constructor() {
    this.sampleRateHz = 16000;
    this.numberSamples = 0;
    this.frequencyBandToSoundPeaks = {};
  }

  encodeToBinary() {
    const header = {
      magic1: 0xcafe2580,
      magic2: 0x94119c00,
      shiftedSampleRateId: 3 << 27, // 16000 Hz = enum 3
      fixedValue: ((15 << 19) + 0x40000),
      numberSamplesPlusDividedSampleRate: Math.round(this.numberSamples + this.sampleRateHz * 0.24),
      crc32: 0,
      sizeMinusHeader: 0
    };

    let contentsBuf = [];
    const bandEntries = Object.entries(this.frequencyBandToSoundPeaks)
      .map(([name, peaks]) => [FrequencyBand[name], peaks])
      .sort((a, b) => a[0] - b[0]);

    for (const [frequencyBand, frequencyPeaks] of bandEntries) {
      if (!frequencyPeaks || frequencyPeaks.length === 0) continue;

      const peaksBuffer = [];
      let fftPassNumber = 0;

      for (const peak of frequencyPeaks) {
        if ((peak.fftPassNumber - fftPassNumber) >= 0xff) {
          peaksBuffer.push(0xff);
          peaksBuffer.push(...writeInt32LE(peak.fftPassNumber));
          fftPassNumber = peak.fftPassNumber;
        }
        peaksBuffer.push(peak.fftPassNumber - fftPassNumber);
        peaksBuffer.push(...writeInt16LE(peak.peakMagnitude - 1));
        peaksBuffer.push(...writeInt16LE(peak.correctedPeakFrequencyBin - 1));
        fftPassNumber = peak.fftPassNumber;
      }

      contentsBuf.push(...writeInt32LE(0x60030040 + frequencyBand));
      contentsBuf.push(...writeInt32LE(peaksBuffer.length));
      contentsBuf = contentsBuf.concat(peaksBuffer);

      const paddingCount = 4 - (peaksBuffer.length % 4);
      if (paddingCount < 4) {
        contentsBuf.push(...Array(paddingCount).fill(0));
      }
    }

    header.sizeMinusHeader = contentsBuf.length + 8;

    let buf = [];
    const rawHeader = new Uint8Array(48);
    const dv = new DataView(rawHeader.buffer);
    dv.setUint32(0, header.magic1 >>> 0, true);
    dv.setUint32(4, 0, true);
    dv.setUint32(8, header.sizeMinusHeader >>> 0, true);
    dv.setUint32(12, header.magic2 >>> 0, true);
    dv.setUint32(28, header.shiftedSampleRateId >>> 0, true);
    dv.setUint32(40, header.numberSamplesPlusDividedSampleRate >>> 0, true);
    dv.setUint32(44, header.fixedValue >>> 0, true);

    buf.push(...rawHeader);
    buf.push(...writeInt32LE(0x40000000));
    buf.push(...writeInt32LE(contentsBuf.length + 8));
    buf = buf.concat(contentsBuf);

    // CRC32 calculated over data starting after first 8 bytes of header
    const crc = crc32(buf.slice(8));
    dv.setUint32(4, crc >>> 0, true);
    buf.splice(0, 48, ...rawHeader);

    return new Uint8Array(buf);
  }

  encodeToUri() {
    const bin = this.encodeToBinary();
    let binary = '';
    const len = bin.length;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bin[i]);
    }
    return DATA_URI_PREFIX + btoa(binary);
  }

  static decodeFromBinary(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic1 = dv.getUint32(0, true);
    const crc = dv.getUint32(4, true);
    const sizeMinusHeader = dv.getUint32(8, true);
    const magic2 = dv.getUint32(12, true);
    const shiftedSampleRateId = dv.getUint32(28, true);
    const numberSamplesPlusDividedSampleRate = dv.getUint32(40, true);

    if (magic1 !== 0xcafe2580 || magic2 !== 0x94119c00) {
      throw new Error(`Invalid Shazam signature magic bytes (0x${magic1.toString(16)}, 0x${magic2.toString(16)})`);
    }

    const self = new DecodedMessage();
    self.sampleRateHz = 16000;
    self.numberSamples = Math.round(numberSamplesPlusDividedSampleRate - self.sampleRateHz * 0.24);

    let ptr = 48; // Skip 48-byte header
    // Skip outer wrapper chunk (0x40000000 + length)
    if (ptr + 8 <= bytes.length) {
      ptr += 8;
    }

    while (ptr + 8 <= bytes.length) {
      const frequencyBandId = dv.getInt32(ptr, true);
      const frequencyPeaksSize = dv.getInt32(ptr + 4, true);
      ptr += 8;

      const bandIndex = frequencyBandId - 0x60030040;
      const bandName = FrequencyBandNames[String(bandIndex)] || `band_${bandIndex}`;
      self.frequencyBandToSoundPeaks[bandName] = [];

      const endOfBand = Math.min(bytes.length, ptr + frequencyPeaksSize);
      let fftPassNumber = 0;

      while (ptr < endOfBand) {
        let passOffset = bytes[ptr++];
        if (passOffset === 0xff) {
          fftPassNumber = dv.getInt32(ptr, true);
          ptr += 4;
        } else {
          fftPassNumber += passOffset;
        }

        if (ptr + 4 > endOfBand) break;
        const peakMag = dv.getInt16(ptr, true) + 1;
        const bin = dv.getInt16(ptr + 2, true) + 1;
        ptr += 4;

        self.frequencyBandToSoundPeaks[bandName].push(
          new FrequencyPeak(fftPassNumber, peakMag, bin, self.sampleRateHz)
        );
      }

      // 4-byte padding alignment
      const padding = (4 - (frequencyPeaksSize % 4)) % 4;
      ptr += padding;
    }

    return self;
  }

  static decodeFromUri(uri) {
    if (!uri || !uri.startsWith(DATA_URI_PREFIX)) {
      throw new Error('Invalid Shazam signature URI prefix.');
    }
    const b64 = uri.slice(DATA_URI_PREFIX.length);
    const binStr = atob(b64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return DecodedMessage.decodeFromBinary(bytes);
  }
}

export class SignatureGenerator {
  constructor() {
    this.initFields();
  }

  initFields() {
    this.ringBufferOfSamples = new RingBuffer(2048, 0);
    this.fftOutputs = new RingBuffer(256, () => new Float32Array(1025));
    this.spreadFFTsOutput = new RingBuffer(256, () => new Float32Array(1025));
    this.nextSignature = new DecodedMessage();
    this.nextSignature.sampleRateHz = 16000;
    this.nextSignature.numberSamples = 0;
    this.nextSignature.frequencyBandToSoundPeaks = {};
    this.num_spread_ffts_done = 0;
  }

  getSignature(samples) {
    const sliceLength = Math.min(12 * 16000, samples.length);
    let s16le = samples;
    if (samples.length > 12 * 16000) {
      const middle = Math.floor(samples.length / 2);
      s16le = samples.slice(middle - 6 * 16000, middle + 6 * 16000);
    }
    s16le = s16le.slice(0, sliceLength);
    this.nextSignature.numberSamples += s16le.length;

    for (let i = 0; i < s16le.length; i += 128) {
      this.doFFT(s16le.slice(i, i + 128));
      this.doPeakSpreading();
      this.num_spread_ffts_done++;
      if (this.num_spread_ffts_done >= 46) {
        this.doPeakRecognition();
      }
    }

    const ret = this.nextSignature;
    this.initFields();
    return ret;
  }

  doFFT(batch) {
    this.ringBufferOfSamples.list.splice(this.ringBufferOfSamples.position, batch.length, ...batch);
    this.ringBufferOfSamples.position += batch.length;
    this.ringBufferOfSamples.position %= 2048;

    const excerpt = [
      ...this.ringBufferOfSamples.list.slice(this.ringBufferOfSamples.position),
      ...this.ringBufferOfSamples.list.slice(0, this.ringBufferOfSamples.position)
    ].map((v, i) => v * HANNING_MATRIX[i]);

    const fft = new FFT(2048);
    const out = fft.createComplexArray();
    fft.realTransform(out, excerpt);

    const results = this.fftOutputs.list[pyMod(this.fftOutputs.position++, this.fftOutputs.bufferSize)];
    for (let i = 0; i < 2050; i += 2) {
      const e = (out[i] * out[i] + out[i + 1] * out[i + 1]) / (1 << 17);
      results[i / 2] = Math.max(1e-10, e);
    }
  }

  doPeakSpreading() {
    const originLastFFT = this.fftOutputs.list[pyMod(this.fftOutputs.position - 1, this.fftOutputs.bufferSize)];
    const spreadLastFFT = this.spreadFFTsOutput.list[pyMod(this.spreadFFTsOutput.position, this.spreadFFTsOutput.bufferSize)];
    spreadLastFFT.set(originLastFFT);

    for (let position = 0; position <= 1022; position++) {
      spreadLastFFT[position] = Math.max(spreadLastFFT[position], spreadLastFFT[position + 1], spreadLastFFT[position + 2]);
    }

    for (let position = 0; position <= 1024; position++) {
      for (const formerFftNum of [-1, -3, -6]) {
        const formerFftOutput = this.spreadFFTsOutput.list[pyMod(this.spreadFFTsOutput.position + formerFftNum, this.spreadFFTsOutput.bufferSize)];
        formerFftOutput[position] = Math.max(formerFftOutput[position], spreadLastFFT[position]);
      }
    }

    this.spreadFFTsOutput.position++;
  }

  doPeakRecognition() {
    const fftMinus46 = this.fftOutputs.list[pyMod(this.fftOutputs.position - 46, this.fftOutputs.bufferSize)];
    const fftMinus49 = this.spreadFFTsOutput.list[pyMod(this.spreadFFTsOutput.position - 49, this.spreadFFTsOutput.bufferSize)];

    for (let binPosition = 10; binPosition <= 1014; binPosition++) {
      if (fftMinus46[binPosition] >= 1 / 64 && fftMinus46[binPosition] >= fftMinus49[binPosition - 1]) {
        let maxNeighborInFftMinus49 = 0;
        for (const neighborOffset of [-10, -7, -4, -3, 1, 2, 5, 8]) {
          const candidate = fftMinus49[binPosition + neighborOffset];
          maxNeighborInFftMinus49 = Math.max(candidate, maxNeighborInFftMinus49);
        }

        if (fftMinus46[binPosition] > maxNeighborInFftMinus49) {
          let maxNeighborInOther = maxNeighborInFftMinus49;
          for (const otherOffset of [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249]) {
            const candidate = this.spreadFFTsOutput.list[pyMod(this.spreadFFTsOutput.position + otherOffset, this.spreadFFTsOutput.bufferSize)][binPosition - 1];
            maxNeighborInOther = Math.max(candidate, maxNeighborInOther);
          }

          if (fftMinus46[binPosition] > maxNeighborInOther) {
            const fftNumber = this.num_spread_ffts_done - 46;
            const peakMag = Math.log(Math.max(1 / 64, fftMinus46[binPosition])) * 1477.3 + 6144;
            const peakMagBefore = Math.log(Math.max(1 / 64, fftMinus46[binPosition - 1])) * 1477.3 + 6144;
            const peakMagAfter = Math.log(Math.max(1 / 64, fftMinus46[binPosition + 1])) * 1477.3 + 6144;

            const peakVar1 = peakMag * 2 - peakMagBefore - peakMagAfter;
            const peakVar2 = (peakMagAfter - peakMagBefore) * 32 / peakVar1;
            const correctedBin = ((binPosition * 64 + peakVar2) & 0xFFFF) >>> 0;
            const freqHz = correctedBin * (16000 / 2 / 1024 / 64);

            let bandName;
            if (freqHz < 250) continue;
            else if (freqHz < 520) bandName = '_250_520';
            else if (freqHz < 1450) bandName = '_520_1450';
            else if (freqHz < 3500) bandName = '_1450_3500';
            else if (freqHz <= 5500) bandName = '_3500_5500';
            else continue;

            if (!this.nextSignature.frequencyBandToSoundPeaks[bandName]) {
              this.nextSignature.frequencyBandToSoundPeaks[bandName] = [];
            }
            this.nextSignature.frequencyBandToSoundPeaks[bandName].push(
              new FrequencyPeak(fftNumber, (Math.round(peakMag)) & 0xFFFF, Math.round(correctedBin), 16000)
            );
          }
        }
      }
    }
  }
}

/**
 * Parse an audio buffer (WAV container, or raw 16-bit PCM bytes)
 * and normalize to 16,000 Hz 16-bit mono PCM sample array.
 * 
 * @param {Uint8Array|ArrayBuffer} buffer
 * @returns {Int16Array|null}
 */
export function parseWavTo16kSamples(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!bytes || bytes.length === 0) return null;

  // If payload is already a text-based data URI
  if (bytes[0] === 0x64 && bytes[1] === 0x61 && bytes[2] === 0x74 && bytes[3] === 0x61) {
    // Starts with "data"
    return null;
  }

  // Check for RIFF/WAVE header
  const isRiff = bytes.length >= 12 &&
                 bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
                 bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;

  if (!isRiff) {
    // Treat as raw 16-bit PCM mono
    const samplesCount = Math.floor(bytes.length / 2);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const s16 = new Int16Array(samplesCount);
    for (let i = 0; i < samplesCount; i++) {
      s16[i] = dv.getInt16(i * 2, true);
    }
    return s16;
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkSize = dv.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      numChannels = dv.getUint16(offset + 10, true);
      sampleRate = dv.getUint32(offset + 12, true);
      bitsPerSample = dv.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, bytes.length - dataOffset);
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  if (dataOffset === -1 || dataSize <= 0) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalFrames = Math.floor(dataSize / (numChannels * bytesPerSample));
  const rawMono = new Float32Array(totalFrames);

  for (let f = 0; f < totalFrames; f++) {
    let frameSum = 0;
    for (let c = 0; c < numChannels; c++) {
      const sampleByteOffset = dataOffset + (f * numChannels + c) * bytesPerSample;
      if (bitsPerSample === 16) {
        frameSum += dv.getInt16(sampleByteOffset, true) / 32768.0;
      } else if (bitsPerSample === 8) {
        frameSum += (bytes[sampleByteOffset] - 128) / 128.0;
      } else if (bitsPerSample === 32) {
        frameSum += dv.getFloat32(sampleByteOffset, true);
      }
    }
    rawMono[f] = frameSum / numChannels;
  }

  // Exact 16 kHz mono
  if (sampleRate === 16000) {
    const out = new Int16Array(totalFrames);
    for (let i = 0; i < totalFrames; i++) {
      const s = Math.max(-1, Math.min(1, rawMono[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  // Resample to 16,000 Hz using linear interpolation
  const targetLength = Math.floor((totalFrames * 16000) / sampleRate);
  const resampled = new Int16Array(targetLength);
  const ratio = (totalFrames - 1) / Math.max(1, targetLength - 1);

  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const s0 = rawMono[srcIndex] || 0;
    const s1 = rawMono[Math.min(totalFrames - 1, srcIndex + 1)] || 0;
    const val = s0 + frac * (s1 - s0);
    const clamped = Math.max(-1, Math.min(1, val));
    resampled[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }

  return resampled;
}

/**
 * Generate a 16 kHz 16-bit mono WAV buffer from Int16Array or Float32Array
 * @param {Int16Array|Float32Array|Array<number>} samples
 * @returns {Uint8Array}
 */
export function encode16kWav(samples) {
  const byteLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + byteLength);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + byteLength, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, 16000, true); // Sample rate 16000
  view.setUint32(28, 32000, true); // Byte rate (16000 * 2)
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  // data chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, byteLength, true);

  const isFloat = samples instanceof Float32Array;
  for (let i = 0; i < samples.length; i++) {
    let s;
    if (isFloat) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      s = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    } else {
      s = samples[i];
    }
    view.setInt16(44 + i * 2, s, true);
  }

  return new Uint8Array(buffer);
}

/**
 * High-level generator that returns `{ uri, samplems }` from any audio input
 * (WAV, PCM, or already-encoded signature URI).
 * 
 * @param {Uint8Array|ArrayBuffer|string} input
 * @returns {{ uri: string, samplems: number }}
 */
export function generateShazamSignature(input) {
  if (typeof input === 'string' && input.startsWith(DATA_URI_PREFIX)) {
    return {
      uri: input,
      samplems: 8000
    };
  }

  const bytes = input instanceof Uint8Array ? input : (typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input));

  // Check if string signature in Uint8Array
  if (bytes.length > 30 && bytes[0] === 0x64 && bytes[1] === 0x61 && bytes[2] === 0x74 && bytes[3] === 0x61) {
    const str = new TextDecoder().decode(bytes);
    if (str.startsWith(DATA_URI_PREFIX)) {
      return {
        uri: str.trim(),
        samplems: 8000
      };
    }
  }

  const samples = parseWavTo16kSamples(bytes);
  if (!samples || samples.length === 0) {
    throw new Error('Unable to parse audio samples for Shazam fingerprint generation.');
  }

  const generator = new SignatureGenerator();
  const signature = generator.getSignature(Array.from(samples));
  const uri = signature.encodeToUri();
  const samplems = Math.round((signature.numberSamples / 16000) * 1000);

  return { uri, samplems };
}
