/**
 * LyricWave Configuration
 * 
 * Edit this file with your Spotify Application credentials.
 * For setup help, see SPOTIFY_SETUP.md.
 */

export const CONFIG = {
  /**
   * Your Spotify Client ID from developer.spotify.com/dashboard
   * Replace the placeholder string below with your 32-character Client ID.
   */
  CLIENT_ID: "YOUR_SPOTIFY_CLIENT_ID",

  /**
   * The Redirect URI where Spotify will send users back after authorizing.
   * MUST match character-for-character with what you added in your Spotify Dashboard.
   * By default, this uses your current origin + path (e.g. http://127.0.0.1:8080/ or http://localhost:3000/)
   */
  REDIRECT_URI: typeof window !== 'undefined'
    ? window.location.origin + window.location.pathname.replace(/\/index\.html$/, "/")
    : "http://127.0.0.1:8080/",

  /**
   * Permissions requested from Spotify:
   * - user-read-currently-playing: Detect currently playing track
   * - user-read-playback-state: Detect playback progress, pause/play state
   * - user-read-private: Fetch display name and profile picture for logged-in UI
   */
  SCOPES: [
    "user-read-currently-playing",
    "user-read-playback-state",
    "user-read-private"
  ],

  /**
   * Last.fm API Key (Optional override).
   * If not provided, LastFmSource falls back to the public demo key.
   */
  LASTFM_API_KEY: "",

  /**
   * Default Acoustic Recognition Provider ('acrcloud' or 'audd').
   */
  RECOGNITION_PROVIDER: "acrcloud",

  /**
   * Base URL for serverless backend API endpoints (/api/recognize, /api/charts, /api/news).
   * Automatically targets https://lyricwave.pages.dev when running inside standalone Android app.
   */
  API_BASE_URL: (typeof window !== 'undefined' && (
      window.location.hostname === 'appassets.androidplatform.net' ||
      window.location.protocol === 'file:'
    ))
    ? 'https://lyricwave.pages.dev'
    : ''
};


