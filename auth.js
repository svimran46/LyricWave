/**
 * Spotify PKCE Authentication Module for LyricWave
 * 
 * Implements RFC 7636 Authorization Code Flow with Proof Key for Code Exchange (PKCE).
 * Runs completely in-browser with zero backend and no client secret.
 */

import { CONFIG } from './config.js';

const STORAGE_KEYS = {
  ACCESS_TOKEN: 'lyricwave_access_token',
  REFRESH_TOKEN: 'lyricwave_refresh_token',
  EXPIRES_AT: 'lyricwave_expires_at',
  CODE_VERIFIER: 'lyricwave_code_verifier',
  AUTH_STATE: 'lyricwave_auth_state',
  USER_PROFILE: 'lyricwave_user_profile'
};

const SPOTIFY_AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const SPOTIFY_ME_ENDPOINT = 'https://api.spotify.com/v1/me';

let refreshInFlight = null;

/**
 * Generate a cryptographically secure random string for PKCE code verifier
 */
function generateRandomString(length = 64) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const randomValues = new Uint8Array(length);
  window.crypto.getRandomValues(randomValues);
  return Array.from(randomValues, (byte) => possible[byte % possible.length]).join('');
}

/**
 * Compute SHA-256 hash of a string
 */
async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest('SHA-256', data);
}

/**
 * Encode an ArrayBuffer into base64url string without padding
 */
function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate PKCE code challenge from code verifier
 */
async function generateCodeChallenge(codeVerifier) {
  const hashed = await sha256(codeVerifier);
  return base64url(hashed);
}

/**
 * Redirect user to Spotify authorization page with PKCE parameters
 */
export async function initiateLogin() {
  if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID === 'YOUR_SPOTIFY_CLIENT_ID') {
    console.error('LyricWave Setup Notice: CONFIG.CLIENT_ID is not configured in config.js. See README.md or SPOTIFY_SETUP.md for setup instructions.');
    throw new Error('Spotify login is temporarily unavailable. Try Microphone or Search instead.');
  }

  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(16);

  // Store verifier and state for validation upon redirect
  sessionStorage.setItem(STORAGE_KEYS.CODE_VERIFIER, codeVerifier);
  sessionStorage.setItem(STORAGE_KEYS.AUTH_STATE, state);

  const params = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    response_type: 'code',
    redirect_uri: CONFIG.REDIRECT_URI,
    state: state,
    scope: CONFIG.SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });

  window.location.href = `${SPOTIFY_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Handles callback from Spotify redirect.
 * Returns { status: 'none' | 'success' | 'error', error?: string }
 */
export async function handleRedirectCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const error = urlParams.get('error');
  const errorDescription = urlParams.get('error_description') || '';
  const returnedState = urlParams.get('state');

  // No callback parameters in URL
  if (!code && !error) {
    return { status: 'none' };
  }

  // Clear query parameters from address bar cleanly
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);

  // User or Spotify returned an error
  if (error) {
    console.warn(`Spotify authorization callback reported: error=${error}, description=${errorDescription}`);
    if (error === 'access_denied') {
      if (errorDescription.toLowerCase().includes('user') || errorDescription.toLowerCase().includes('allowlist') || errorDescription.toLowerCase().includes('not registered')) {
        return {
          status: 'error',
          error: 'Spotify access is currently limited to invited testers. Try Microphone or Search instead.'
        };
      }
      return {
        status: 'error',
        error: 'Spotify login was cancelled or access is limited to invited testers. Try Microphone or Search instead.'
      };
    }
    return {
      status: 'error',
      error: 'Spotify login was unsuccessful. Try Microphone or Search instead.'
    };
  }

  // Validate state to prevent CSRF attacks
  const storedState = sessionStorage.getItem(STORAGE_KEYS.AUTH_STATE);
  sessionStorage.removeItem(STORAGE_KEYS.AUTH_STATE);

  if (!returnedState || returnedState !== storedState) {
    return {
      status: 'error',
      error: 'Security state verification failed (possible CSRF or session mismatch). Please try again.'
    };
  }

  // Retrieve code verifier
  const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.CODE_VERIFIER);
  sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);

  if (!codeVerifier) {
    return {
      status: 'error',
      error: 'Missing PKCE code verifier in session. Please initiate login again.'
    };
  }

  // Exchange authorization code for access & refresh tokens
  try {
    const payload = new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: CONFIG.REDIRECT_URI,
      code_verifier: codeVerifier
    });

    const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: payload.toString()
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.error_description || data.error || 'Failed to exchange authorization code for tokens.';
      return { status: 'error', error: errorMsg };
    }

    saveTokens(data);

    // Fetch and store user profile
    await fetchUserProfile();

    return { status: 'success' };
  } catch (err) {
    return {
      status: 'error',
      error: `Network error during token exchange: ${err.message}`
    };
  }
}

/**
 * Stores tokens and calculates expiration timestamp
 */
function saveTokens(tokenData) {
  if (tokenData.access_token) {
    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, tokenData.access_token);
  }
  if (tokenData.refresh_token) {
    localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, tokenData.refresh_token);
  }

  // Set expiration timestamp with 60-second safety margin
  const expiresInSeconds = tokenData.expires_in || 3600;
  const expiresAt = Date.now() + (expiresInSeconds * 1000) - 60000;
  localStorage.setItem(STORAGE_KEYS.EXPIRES_AT, expiresAt.toString());
}

/**
 * Refreshes access token using the stored refresh token
 */
export async function refreshAccessToken() {
  const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);

  if (!refreshToken) {
    logout();
    throw new Error('No refresh token available. Session has expired.');
  }

  // Share one in-flight refresh between concurrent callers: Spotify rotates refresh
  // tokens, so two parallel refreshes can invalidate each other.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const payload = new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });

    let response;
    try {
      response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: payload.toString()
      });
    } catch (networkErr) {
      // Offline / flaky network: keep the refresh token and try again on the next poll.
      const err = new Error('Network error while refreshing Spotify session.');
      err.transient = true;
      throw err;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // Only a rejected grant means the session is really gone. 5xx / 429 are temporary.
      if (response.status === 400 || response.status === 401) {
        logout();
        const msg = data.error_description || data.error || 'Session refresh failed';
        throw new Error(`Your Spotify session has expired (${msg}). Please log in again.`);
      }
      const err = new Error(`Spotify token service unavailable (HTTP ${response.status}).`);
      err.transient = true;
      throw err;
    }

    saveTokens(data);
    return data.access_token;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Returns a guaranteed valid access token, automatically refreshing if close to expiry
 */
export async function getValidAccessToken() {
  if (typeof localStorage === 'undefined') return null;
  const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
  const expiresAt = parseInt(localStorage.getItem(STORAGE_KEYS.EXPIRES_AT) || '0', 10);
  const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);

  if (!accessToken || !refreshToken) {
    return null;
  }

  // If token is expired or within 60 seconds of expiration, refresh it
  if (Date.now() >= expiresAt) {
    try {
      return await refreshAccessToken();
    } catch (err) {
      // Transient failure: let the caller retry later instead of treating it as logged out.
      if (err && err.transient) throw err;
      return null;
    }
  }

  return accessToken;
}

/**
 * Fetches Spotify user profile for currently logged in user
 */
export async function fetchUserProfile() {
  const token = await getValidAccessToken();
  if (!token) {
    throw new Error('Not authenticated.');
  }

  const response = await fetch(SPOTIFY_ME_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      // Token might be invalid, try one refresh
      const refreshedToken = await refreshAccessToken();
      const retryResponse = await fetch(SPOTIFY_ME_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${refreshedToken}`
        }
      });
      if (retryResponse.ok) {
        const profile = await retryResponse.json();
        localStorage.setItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(profile));
        return profile;
      }
    }
    throw new Error(`Failed to fetch user profile (HTTP ${response.status})`);
  }

  const profile = await response.json();
  localStorage.setItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(profile));
  return profile;
}

/**
 * Retrieves cached user profile from localStorage
 */
export function getStoredUserProfile() {
  const data = localStorage.getItem(STORAGE_KEYS.USER_PROFILE);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Checks if user currently has stored tokens
 */
export function isAuthenticated() {
  return Boolean(
    localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN) &&
    localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN)
  );
}

/**
 * Clears all tokens and session state
 */
export function logout() {
  localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.EXPIRES_AT);
  localStorage.removeItem(STORAGE_KEYS.USER_PROFILE);
  sessionStorage.removeItem(STORAGE_KEYS.CODE_VERIFIER);
  sessionStorage.removeItem(STORAGE_KEYS.AUTH_STATE);
}

/**
 * Returns seconds remaining until token expiration
 */
export function getTokenTimeRemaining() {
  const expiresAt = parseInt(localStorage.getItem(STORAGE_KEYS.EXPIRES_AT) || '0', 10);
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}
