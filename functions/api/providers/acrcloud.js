/**
 * ACRCloud Recognition Provider
 * 
 * Implements the RecognitionProvider interface using ACRCloud's
 * HTTP REST Audio Identification API with HMAC-SHA1 signature.
 * 
 * Never logs or stores raw audio.
 */

import { RecognitionProvider } from './base.js';

export class ACRCloudProvider extends RecognitionProvider {
  /**
   * @param {Object} options
   * @param {string} options.host - ACRCloud endpoint host (e.g. identify-eu-west-1.acrcloud.com)
   * @param {string} options.accessKey - ACRCloud Access Key
   * @param {string} options.accessSecret - ACRCloud Access Secret
   */
  constructor(options = {}) {
    super(options);
    this.name = 'acrcloud';
    this.host = (options.host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    this.accessKey = (options.accessKey || '').trim();
    this.accessSecret = (options.accessSecret || '').trim();
  }

  /**
   * Generate HMAC-SHA1 signature using standard Web Crypto API (SubtleCrypto)
   * Compatible with Cloudflare Workers / Pages Functions and modern Node.
   * 
   * string_to_sign = HTTP-METHOD + "\n" + HTTP-URI + "\n" + ACCESS-KEY + "\n" + DATA_TYPE + "\n" + SIGNATURE_VERSION + "\n" + TIMESTAMP
   * 
   * @param {string} stringToSign
   * @param {string} keyString
   * @returns {Promise<string>} Base64-encoded signature
   */
  static async generateSignature(stringToSign, keyString) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(keyString);
    const messageData = encoder.encode(stringToSign);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: { name: 'SHA-1' } },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const signatureBytes = new Uint8Array(signatureBuffer);

    // Convert binary bytes to Base64
    let binary = '';
    for (let i = 0; i < signatureBytes.length; i++) {
      binary += String.fromCharCode(signatureBytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Recognize an audio sample
   * @param {Uint8Array|ArrayBuffer} audioBuffer
   * @returns {Promise<import('./base.js').NormalizedRecognitionResult>}
   */
  async recognize(audioBuffer) {
    if (!this.host || !this.accessKey || !this.accessSecret) {
      throw new Error('ACRCloud credentials are not fully configured (missing host, access key, or secret).');
    }

    const uint8 = audioBuffer instanceof Uint8Array ? audioBuffer : new Uint8Array(audioBuffer);
    if (uint8.byteLength === 0) {
      throw new Error('Audio sample is empty.');
    }

    const httpMethod = 'POST';
    const httpUri = '/v1/identify';
    const dataType = 'audio';
    const signatureVersion = '1';
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const stringToSign = `${httpMethod}\n${httpUri}\n${this.accessKey}\n${dataType}\n${signatureVersion}\n${timestamp}`;
    const signature = await ACRCloudProvider.generateSignature(stringToSign, this.accessSecret);

    // Construct multipart/form-data payload
    const formData = new FormData();
    const audioBlob = new Blob([uint8], { type: 'application/octet-stream' });

    formData.append('sample', audioBlob, 'sample.bin');
    formData.append('sample_bytes', uint8.byteLength.toString());
    formData.append('access_key', this.accessKey);
    formData.append('data_type', dataType);
    formData.append('signature_version', signatureVersion);
    formData.append('signature', signature);
    formData.append('timestamp', timestamp);

    const endpointUrl = `https://${this.host}${httpUri}`;

    const response = await fetch(endpointUrl, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`ACRCloud request failed with status ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    return this.normalizeResponse(data);
  }

  /**
   * Normalize ACRCloud JSON response into standard format
   * 
   * @param {Object} rawData
   * @returns {import('./base.js').NormalizedRecognitionResult}
   */
  normalizeResponse(rawData) {
    const status = rawData?.status || {};
    const statusCode = status.code;

    // Code 0 = Success match found
    if (statusCode === 0) {
      const musicList = rawData?.metadata?.music || [];
      if (musicList.length === 0) {
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

      // Select top matching track
      const topMatch = musicList[0];
      const title = topMatch.title || 'Unknown Title';
      
      const artist = Array.isArray(topMatch.artists)
        ? topMatch.artists.map(a => a.name).filter(Boolean).join(', ')
        : (topMatch.artists?.name || 'Unknown Artist');
        
      const album = topMatch.album?.name || '';
      const duration = topMatch.duration_ms ? Math.round(topMatch.duration_ms / 1000) : 0;
      
      // Determine match offset in the track:
      // ACRCloud provides play_offset_ms or db_begin_time_offset_ms
      let offsetMs = null;
      if (typeof topMatch.play_offset_ms === 'number') {
        offsetMs = Math.round(topMatch.play_offset_ms);
      } else if (typeof topMatch.db_begin_time_offset_ms === 'number') {
        offsetMs = Math.round(topMatch.db_begin_time_offset_ms);
      }

      const confidence = typeof topMatch.score === 'number' ? topMatch.score : 100;

      // Extra lookup hints for lyric matching. ACRCloud's own title/artist strings are
      // sometimes localized, romanized or carry release suffixes that LRCLIB doesn't have;
      // the Spotify/Deezer names it links to are usually the canonical ones.
      const lookupCandidates = [];
      const pushCandidate = (t, a, d) => {
        const ct = String(t || '').trim();
        const ca = String(a || '').trim();
        if (!ct) return;
        const key = `${ct}__${ca}`.toLowerCase();
        if (lookupCandidates.some(c => `${c.title}__${c.artist}`.toLowerCase() === key)) return;
        lookupCandidates.push({ title: ct, artist: ca, duration: d || 0 });
      };
      for (const m of musicList.slice(0, 3)) {
        const ext = m.external_metadata || {};
        const sp = ext.spotify || {};
        const dz = ext.deezer || {};
        const d = m.duration_ms ? Math.round(m.duration_ms / 1000) : 0;
        const namesOf = (arr) => (Array.isArray(arr) ? arr.map(x => x?.name).filter(Boolean).join(', ') : '');
        pushCandidate(sp.track?.name, namesOf(sp.artists), d);
        pushCandidate(dz.track?.name, namesOf(dz.artists), d);
        pushCandidate(m.title, namesOf(m.artists), d);
      }

      return {
        success: true,
        title,
        artist,
        album,
        duration,
        offsetMs,
        confidence,
        provider: this.name,
        lookupCandidates: lookupCandidates.slice(0, 6),
        raw: {
          acrid: topMatch.acrid || null,
          genres: topMatch.genres?.map(g => g.name) || [],
          releaseDate: topMatch.release_date || null,
          externalIds: topMatch.external_ids || {},
          spotifyTrackId: topMatch.external_metadata?.spotify?.track?.id || null
        }
      };
    }

    // Code 1001 = No result found (not a server error, simply no music match in database)
    if (statusCode === 1001) {
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

    // Other non-zero status codes indicate API errors
    throw new Error(`ACRCloud returned code ${statusCode}: ${status.msg || 'Unknown API error'}`);
  }
}
