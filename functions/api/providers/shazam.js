/**
 * Shazam Music Recognition Provider
 *
 * Implements the RecognitionProvider interface on Shazam's discovery ("tag") API.
 *
 * The client normally fingerprints the audio itself and sends only the signature
 * (`data:audio/vnd.shazam.sig;base64,...`, a few KB), so this provider is a thin proxy:
 * it costs the Worker almost no CPU. Raw WAV/PCM is still accepted and fingerprinted here
 * as a fallback for old clients.
 *
 * Privacy: everything runs in memory; audio and signatures are never logged or stored.
 */

import { RecognitionProvider } from './base.js';
import {
  generateShazamSignature,
  isValidSignatureUri,
  samplemsFromUri,
  buildShazamRequest,
  normalizeShazamResponse
} from '../../../shazam-core.js';

const REQUEST_TIMEOUT_MS = 9000;

export class ShazamProvider extends RecognitionProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.timezone] - Timezone string (default: 'UTC')
   * @param {string} [options.endpoint] - Custom endpoint host (default: 'https://amp.shazam.com')
   */
  constructor(options = {}) {
    super(options);
    this.name = 'shazam';
    this.timezone = options.timezone || 'UTC';
    this.endpoint = options.endpoint || undefined;
    this.fetchImpl = options.fetch || null;
  }

  /** Shazam needs no credentials. */
  isConfigured() {
    return true;
  }

  /**
   * @param {Uint8Array|ArrayBuffer|null} audioBuffer
   * @param {{ signatureUri?: string, samplems?: number }} [options]
   * @returns {Promise<import('./base.js').NormalizedRecognitionResult>}
   */
  async recognize(audioBuffer, options = {}) {
    let signature;
    if (isValidSignatureUri(options.signatureUri)) {
      signature = {
        uri: options.signatureUri,
        samplems: Number(options.samplems) > 0 ? Number(options.samplems) : samplemsFromUri(options.signatureUri)
      };
    } else if (audioBuffer && audioBuffer.byteLength > 0) {
      const bytes = audioBuffer instanceof Uint8Array ? audioBuffer : new Uint8Array(audioBuffer);
      const isWav = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
      if (!isWav && !options.allowRawPcm) {
        // WebM/MP4 can't be decoded in a Worker; fingerprinting it as PCM would only produce noise.
        throw new Error('Shazam needs a WAV sample or a client-side signature.');
      }
      signature = generateShazamSignature(bytes);
    } else {
      throw new Error('No audio or valid Shazam signature was provided.');
    }

    const { url, init } = buildShazamRequest(signature, { endpoint: this.endpoint, timezone: this.timezone });
    const doFetch = this.fetchImpl || fetch;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    let response;
    try {
      response = await doFetch(url, { ...init, signal: controller ? controller.signal : undefined });
    } catch (err) {
      throw new Error(err && err.name === 'AbortError' ? 'Shazam did not answer in time.' : `Shazam request failed: ${err.message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const err = new Error(`Shazam discovery API failed with HTTP ${response.status}: ${errText.slice(0, 160)}`);
      err.upstreamStatus = response.status;
      throw err;
    }

    return this.normalizeResponse(await response.json());
  }

  normalizeResponse(rawData) {
    return normalizeShazamResponse(rawData);
  }
}
