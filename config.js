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
  CLIENT_ID: "be3c77afea2d4f02a83e3512c6f9232f",

  /**
   * The Redirect URI where Spotify will send users back after authorizing.
   * MUST match character-for-character with what you added in your Spotify Dashboard.
   * By default, this uses your current origin + path (e.g. http://127.0.0.1:8080/ or http://localhost:3000/)
   */
  /**
   * Inside the Android app, login runs in a Chrome Custom Tab and returns through this
   * custom-scheme link (Google/Apple sign-in on Spotify's page is blocked in WebViews).
   * Add BOTH this and the web redirect below to the Spotify Dashboard.
   */
  REDIRECT_URI: (typeof window !== 'undefined' && window.location.hostname === 'appassets.androidplatform.net')
    ? 'lyricwave://callback'
    : typeof window !== 'undefined'
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
  LASTFM_API_KEY: "bb89790d124ab6ab91be569d08e40481",

  /**
   * Default Acoustic Recognition Provider ('acrcloud' or 'audd').
   */
  RECOGNITION_PROVIDER: "acrcloud",

  /**
   * Base URL for serverless backend API endpoints (/api/recognize, /api/charts, /api/news).
   * Automatically targets https://lyricwave.pages.dev when running inside standalone Android app.
   */
  /**
   * Public web address of the app. Used for share links, which must open for other
   * people (inside the Android app window.location is the private appassets origin).
   */
  PUBLIC_WEB_URL: 'https://lyricwave.pages.dev/',

  API_BASE_URL: (typeof window !== 'undefined' && (
      window.location.hostname === 'appassets.androidplatform.net' ||
      window.location.protocol === 'file:'
    ))
    ? 'https://lyricwave.pages.dev'
    : ''
};


