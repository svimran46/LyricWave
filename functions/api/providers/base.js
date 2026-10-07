/**
 * Audio Recognition Provider Base Interface
 * 
 * Standard contract so music recognition backends (ACRCloud, Shazam/AudD, etc.)
 * can be plugged in and swapped seamlessly.
 */

/**
 * @typedef {Object} NormalizedRecognitionResult
 * @property {boolean} success - Whether a song was identified
 * @property {string|null} title - Song title
 * @property {string|null} artist - Primary artist name(s)
 * @property {string|null} album - Album name
 * @property {number} duration - Song duration in seconds
 * @property {number|null} offsetMs - Playback offset position in the song in milliseconds (if available)
 * @property {number} confidence - Match confidence score (0-100)
 * @property {string} provider - Provider name (e.g., 'acrcloud')
 * @property {Object|null} raw - Raw metadata (external IDs, etc.) without audio
 */

export class RecognitionProvider {
  /**
   * @param {Object} config - Provider-specific configuration
   */
  constructor(config = {}) {
    this.name = 'base';
    this.config = config;
  }

  /**
   * Recognize an audio sample
   * @param {Uint8Array|ArrayBuffer} audioBuffer - Audio sample bytes
   * @returns {Promise<NormalizedRecognitionResult>}
   */
  async recognize(audioBuffer) {
    throw new Error('Method "recognize" must be implemented by subclass.');
  }
}
