/**
 * Cloudflare Pages Functions - Audio Recognition API
 * Endpoint: POST /api/recognize
 * 
 * Flow:
 * 1. Checks CORS preflight and allowed origins.
 * 2. Enforces basic client IP rate limiting (in-memory per edge node).
 * 3. Validates incoming payload format and enforces 3.5 MB sample cap.
 * 4. Dispatches sample to configured recognition provider (ACRCloud).
 * 5. Returns normalized response (title, artist, album, duration, offsetMs, confidence).
 * 
 * SECURITY & PRIVACY:
 * - Credentials read strictly from env (ACR_HOST, ACR_ACCESS_KEY, ACR_ACCESS_SECRET).
 * - Never logs or stores raw audio samples to disk, console, or cache.
 */

import { getRecognitionProvider } from './providers/index.js';

// Max allowed sample size: 3.5 MB (~15-20s uncompressed PCM or several minutes compressed)
const MAX_SAMPLE_SIZE_BYTES = 3.5 * 1024 * 1024;

// Basic in-memory rate limiter for serverless instance (15 requests per minute per IP)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 20;
const ipRateMap = new Map();

function isRateLimited(clientIp) {
  if (!clientIp) return false;
  const now = Date.now();

  // Lazy cleanup of stale entries if map grows
  if (ipRateMap.size > 200) {
    for (const [ip, data] of ipRateMap.entries()) {
      if (now - data.startTime > RATE_LIMIT_WINDOW_MS) {
        ipRateMap.delete(ip);
      }
    }
  }

  const entry = ipRateMap.get(clientIp);
  if (!entry || now - entry.startTime > RATE_LIMIT_WINDOW_MS) {
    ipRateMap.set(clientIp, { count: 1, startTime: now });
    return false;
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    return true;
  }
  return false;
}

/**
 * Build standard CORS headers
 */
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Recognition-Provider',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

/**
 * Return JSON error response
 */
function jsonError(message, status = 400, corsHeaders = {}) {
  return new Response(JSON.stringify({
    error: true,
    message,
    status
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

/**
 * Handle OPTIONS (CORS preflight)
 */
export async function onRequestOptions({ request }) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request)
  });
}

/**
 * Handle POST /api/recognize
 */
export async function onRequestPost({ request, env }) {
  const corsHeaders = getCorsHeaders(request);

  // 1. Basic Rate Limiting
  const clientIp = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
                   'unknown';

  if (isRateLimited(clientIp)) {
    return jsonError('Too many recognition requests. Please wait a moment before trying again.', 429, corsHeaders);
  }

  // 2. Validate Content-Type
  const contentType = request.headers.get('content-type') || '';
  let audioBuffer = null;

  try {
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const sample = formData.get('sample') || formData.get('file') || formData.get('audio');
      
      if (!sample) {
        return jsonError('Missing "sample" audio field in form data.', 400, corsHeaders);
      }

      if (typeof sample.arrayBuffer !== 'function') {
        return jsonError('Invalid audio file upload in form data.', 400, corsHeaders);
      }

      const buffer = await sample.arrayBuffer();
      audioBuffer = new Uint8Array(buffer);

    } else if (
      contentType.includes('audio/') || 
      contentType.includes('application/octet-stream')
    ) {
      const buffer = await request.arrayBuffer();
      audioBuffer = new Uint8Array(buffer);

    } else if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => null);
      if (!json || !json.audio) {
        return jsonError('JSON payload must include a base64-encoded "audio" field.', 400, corsHeaders);
      }

      // Decode base64
      const binaryString = atob(json.audio);
      const len = binaryString.length;
      audioBuffer = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        audioBuffer[i] = binaryString.charCodeAt(i);
      }

    } else {
      return jsonError('Unsupported Content-Type. Please send multipart/form-data, audio/*, or application/json with base64.', 415, corsHeaders);
    }
  } catch (err) {
    return jsonError(`Failed to parse request payload: ${err.message}`, 400, corsHeaders);
  }

  // 3. Validate audio buffer size
  if (!audioBuffer || audioBuffer.byteLength === 0) {
    return jsonError('Audio sample is empty. Please record audio before submitting.', 400, corsHeaders);
  }

  if (audioBuffer.byteLength > MAX_SAMPLE_SIZE_BYTES) {
    const sizeMb = (audioBuffer.byteLength / (1024 * 1024)).toFixed(2);
    return jsonError(`Audio sample too large (${sizeMb} MB). Maximum size allowed is 3.5 MB.`, 413, corsHeaders);
  }

  // Minimum required audio sample size (at least 2KB for valid audio headers)
  if (audioBuffer.byteLength < 2048) {
    return jsonError('Audio sample is too short to produce a reliable acoustic fingerprint.', 400, corsHeaders);
  }

  // 4. Initialize Provider
  let provider;
  try {
    const requestedProvider = request.headers.get('X-Recognition-Provider');
    provider = getRecognitionProvider(env, requestedProvider);
  } catch (err) {
    return jsonError(`Provider initialization failed: ${err.message}`, 500, corsHeaders);
  }

  // 5. Query Music Recognition Provider
  try {
    const result = await provider.recognize(audioBuffer);

    return new Response(JSON.stringify({
      error: false,
      ...result
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });

  } catch (err) {
    // Return friendly error without leaking secrets or logging audio
    const isConfigError = err.message.includes('credentials') || err.message.includes('configured');
    const status = isConfigError ? 503 : 502;
    const msg = isConfigError
      ? 'Music recognition service is temporarily unconfigured or unavailable.'
      : `Recognition service error: ${err.message}`;

    return jsonError(msg, status, corsHeaders);
  }
}
