/**
 * Shazam Music Recognition Provider
 * 
 * Implements the RecognitionProvider interface using Shazam's
 * acoustic fingerprinting and Discovery API (amp.shazam.com).
 * 
 * Features:
 * - Pure JavaScript STFT acoustic fingerprint generator (no FFmpeg or native binary needed).
 * - Generates Shazam container signatures (data:audio/vnd.shazam.sig;base64,...).
 * - Full track metadata normalization (title, artist, album, duration, offsetMs, confidence).
 * - Extract linked Spotify & Apple Music identifiers and lookup candidates.
 * 
 * Privacy & Security:
 * - Operates entirely in memory.
 * - Never logs or stores raw audio samples.
 */

import { RecognitionProvider } from './base.js';
import { generateShazamSignature, DATA_URI_PREFIX } from './shazam-signature.js';

const SHAZAM_USER_AGENTS = [
  'Dalvik/2.1.0 (Linux; U; Android 6.0.1; SM-G920F Build/MMB29K)',
  'Dalvik/2.1.0 (Linux; U; Android 7.0; SM-G930F Build/NRD90M)',
  'Dalvik/2.1.0 (Linux; U; Android 8.0.0; Pixel 2 Build/OPD1.170816.010)',
  'Dalvik/2.1.0 (Linux; U; Android 9; SM-G960F Build/PPR1.180610.011)',
  'Dalvik/2.1.0 (Linux; U; Android 10; SM-G973F Build/QP1A.190711.020)',
  'Dalvik/2.1.0 (Linux; U; Android 11; Pixel 5 Build/RD1A.201105.003)',
  'Dalvik/2.1.0 (Linux; U; Android 12; Pixel 6 Build/SQ1D.211205.016.A1)'
];

function getRandomUserAgent() {
  const index = Math.floor(Math.random() * SHAZAM_USER_AGENTS.length);
  return SHAZAM_USER_AGENTS[index];
}

function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }).toUpperCase();
}

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
    this.endpoint = (options.endpoint || 'https://amp.shazam.com').replace(/\/+$/, '');
  }

  /**
   * Recognize an audio sample (WAV buffer, raw PCM, or precomputed signature URI)
   * 
   * @param {Uint8Array|ArrayBuffer|string} audioBuffer
   * @param {Object} [options]
   * @param {string} [options.signatureUri] - Optional precomputed signature URI
   * @returns {Promise<import('./base.js').NormalizedRecognitionResult>}
   */
  async recognize(audioBuffer, options = {}) {
    let signature;

    if (options.signatureUri && typeof options.signatureUri === 'string' && options.signatureUri.startsWith(DATA_URI_PREFIX)) {
      signature = {
        uri: options.signatureUri,
        samplems: options.samplems || 8000
      };
    } else {
      signature = generateShazamSignature(audioBuffer);
    }

    if (!signature || !signature.uri) {
      throw new Error('Failed to generate acoustic fingerprint signature for Shazam.');
    }

    const tagUuid1 = generateUuid();
    const tagUuid2 = generateUuid();
    const url = `${this.endpoint}/discovery/v5/en/US/android/-/tag/${tagUuid1}/${tagUuid2}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3`;

    const payload = {
      timezone: this.timezone,
      signature: {
        uri: signature.uri,
        samplems: signature.samplems
      },
      timestamp: Date.now(),
      context: {},
      geolocation: {}
    };

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': getRandomUserAgent(),
      'X-Shazam-Platform': 'IPHONE',
      'X-Shazam-AppVersion': '14.1.0',
      'Accept': 'application/json'
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Shazam discovery API failed with HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    return this.normalizeResponse(data);
  }

  /**
   * Normalize Shazam JSON response into standard NormalizedRecognitionResult
   * 
   * @param {Object} rawData
   * @returns {import('./base.js').NormalizedRecognitionResult}
   */
  normalizeResponse(rawData) {
    if (!rawData) {
      return {
        success: false,
        title: null,
        artist: null,
        album: null,
        duration: 0,
        offsetMs: null,
        confidence: 0,
        provider: this.name,
        raw: null
      };
    }

    const matches = rawData.matches || [];
    if (matches.length === 0 || !rawData.track) {
      return {
        success: false,
        title: null,
        artist: null,
        album: null,
        duration: 0,
        offsetMs: null,
        confidence: 0,
        provider: this.name,
        raw: null
      };
    }

    const track = rawData.track;
    const match = matches[0] || {};

    const title = track.title || 'Unknown Title';
    const artist = track.subtitle || 'Unknown Artist';

    // Extract song section metadata (Album, Released, Label)
    const songSection = track.sections?.find((s) => s.type === 'SONG');
    const songMeta = songSection?.metadata || [];

    const album = songMeta.find((m) => m.title === 'Album')?.text || '';
    const releaseDate = songMeta.find((m) => m.title === 'Released')?.text || null;
    const label = songMeta.find((m) => m.title === 'Label')?.text || null;

    // Offset in milliseconds
    let offsetMs = null;
    if (typeof match.offset === 'number') {
      offsetMs = Math.round(match.offset * 1000);
    }

    // Confidence estimation from match
    let confidence = 100;
    if (typeof match.timeskew === 'number') {
      confidence = Math.max(50, Math.min(100, Math.round(100 - Math.abs(match.timeskew) * 1000)));
    }

    // Extract Spotify track ID or Apple Music ID if available
    let spotifyTrackId = null;
    let appleMusicId = null;

    if (track.hub?.providers) {
      for (const prov of track.hub.providers) {
        if (prov.type === 'SPOTIFY' && prov.actions) {
          for (const act of prov.actions) {
            if (act.uri && act.uri.includes('spotify:track:')) {
              spotifyTrackId = act.uri.replace('spotify:track:', '').split('?')[0];
            }
          }
        }
      }
    }

    if (track.myshazam?.apple?.actions) {
      for (const act of track.myshazam.apple.actions) {
        if (act.uri && act.uri.includes('id=')) {
          const matchId = act.uri.match(/id=(\d+)/);
          if (matchId) appleMusicId = matchId[1];
        }
      }
    }

    // Lookup candidates for resilient lyric fetching
    const lookupCandidates = [];
    const addCand = (t, a) => {
      const ct = String(t || '').trim();
      const ca = String(a || '').trim();
      if (!ct) return;
      const key = `${ct}__${ca}`.toLowerCase();
      if (!lookupCandidates.some((c) => `${c.title}__${c.artist}`.toLowerCase() === key)) {
        lookupCandidates.push({ title: ct, artist: ca, duration: 0 });
      }
    };

    addCand(title, artist);
    // Remove "feat. ..." or parentheses in alternate candidate
    const cleanTitle = title.replace(/\s*\([^)]*\)/g, '').replace(/\s*-\s*.*$/, '').trim();
    if (cleanTitle !== title) {
      addCand(cleanTitle, artist);
    }

    return {
      success: true,
      title,
      artist,
      album,
      duration: 0,
      offsetMs,
      confidence,
      provider: this.name,
      lookupCandidates,
      raw: {
        shazamKey: track.key || null,
        isrc: track.isrc || null,
        genres: track.genres?.primary ? [track.genres.primary] : [],
        releaseDate,
        label,
        spotifyTrackId,
        appleMusicId,
        coverArt: track.images?.coverart || track.images?.coverarthq || null
      }
    };
  }
}
