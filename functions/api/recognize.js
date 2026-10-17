/**
 * Cloudflare Pages Functions - Audio Recognition API
 * Endpoint: POST /api/recognize
 * 
 * Flow:
 * 1. Checks CORS preflight and allowed origins.
 * 2. Enforces basic client IP rate limiting (in-memory per edge node).
 * 3. Validates incoming payload format and enforces 3.5 MB sample cap.
 * 4. Accepts a client-side Shazam signature (preferred: a few KB, no server CPU) and/or the
 *    audio sample, and walks a provider chain (Shazam, then any configured ACRCloud / AudD).
 * 5. Returns normalized response (title, artist, album, duration, offsetMs, offsetRef, confidence).
 * 
 * SECURITY & PRIVACY:
 * - Credentials read strictly from env (ACR_HOST, ACR_ACCESS_KEY, ACR_ACCESS_SECRET, AUDD_API_TOKEN).
 * - Never logs or stores raw audio samples to disk, console, or cache.
 */

import { getProviderChain } from './providers/index.js';
import { isValidSignatureUri } from '../../shazam-core.js';

// Max allowed sample size: strictly 1 MB (~1,048,576 bytes)
const MAX_SAMPLE_SIZE_BYTES = 1 * 1024 * 1024;

// Per-IP rate limiter (10 recognition requests per minute per IP to protect upstream quota/cost)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
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
 * Check if origin is allowed (same-origin, pages.dev domains, localhost, or 127.0.0.1)
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === 'appassets.androidplatform.net' ||
      host === 'lyricwave.pages.dev' ||
      host.endsWith('.lyricwave.pages.dev')
    );
  } catch {
    return false;
  }
}

/**
 * Build standard CORS headers with allowlist enforcement
 */
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowed = isAllowedOrigin(origin) ? origin : 'null';

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Recognition-Provider, X-Shazam-Signature',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
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
      'Cache-Control': 'no-store, no-cache, must-revalidate',
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

  // Pre-check Content-Length header to immediately reject oversized payloads before reading into memory
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = parseInt(contentLengthHeader, 10);
    if (!isNaN(declaredSize) && declaredSize > MAX_SAMPLE_SIZE_BYTES) {
      const sizeMb = (declaredSize / (1024 * 1024)).toFixed(2);
      return jsonError(`Payload too large (${sizeMb} MB). Maximum allowed size is 1 MB.`, 413, corsHeaders);
    }
  }

  // 2. Parse the payload: a client-side Shazam signature and/or the audio sample itself.
  const contentType = request.headers.get('content-type') || '';
  let audioBuffer = null;
  let signatureUri = request.headers.get('X-Shazam-Signature') || null;
  let samplems = 0;

  try {
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const sample = formData.get('sample') || formData.get('file') || formData.get('audio');
      const formSig = formData.get('signature') || formData.get('shazam_signature');
      if (typeof formSig === 'string' && formSig) signatureUri = formSig;
      samplems = Number(formData.get('samplems')) || 0;

      if (sample && typeof sample !== 'string') {
        if (typeof sample.arrayBuffer !== 'function') {
          return jsonError('Invalid audio file upload in form data.', 400, corsHeaders);
        }
        audioBuffer = new Uint8Array(await sample.arrayBuffer());
      }
    } else if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
      audioBuffer = new Uint8Array(await request.arrayBuffer());
    } else if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => null);
      if (!json || (!json.audio && !json.signature)) {
        return jsonError('JSON payload must include a base64-encoded "audio" or "signature" field.', 400, corsHeaders);
      }
      if (typeof json.signature === 'string') signatureUri = json.signature;
      samplems = Number(json.samplems) || 0;
      if (json.audio) {
        const binaryString = atob(json.audio);
        audioBuffer = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) audioBuffer[i] = binaryString.charCodeAt(i);
      }
    } else {
      return jsonError('Unsupported Content-Type. Please send multipart/form-data, audio/*, or application/json with base64.', 415, corsHeaders);
    }
  } catch (err) {
    return jsonError(`Failed to parse request payload: ${err.message}`, 400, corsHeaders);
  }

  // 3. Validate what we got
  const hasSignature = isValidSignatureUri(signatureUri);
  if (signatureUri && !hasSignature) signatureUri = null; // ignore a malformed signature, use the audio
  const hasAudio = Boolean(audioBuffer && audioBuffer.byteLength > 0);

  if (!hasSignature && !hasAudio) {
    return jsonError('Audio sample is empty. Please record audio before submitting.', 400, corsHeaders);
  }
  if (hasAudio && audioBuffer.byteLength > MAX_SAMPLE_SIZE_BYTES) {
    const sizeMb = (audioBuffer.byteLength / (1024 * 1024)).toFixed(2);
    return jsonError(`Audio sample too large (${sizeMb} MB). Maximum size allowed is 1 MB.`, 413, corsHeaders);
  }
  if (!hasSignature && audioBuffer.byteLength < 2048) {
    return jsonError('Audio sample is too short to produce a reliable acoustic fingerprint.', 400, corsHeaders);
  }

  // 4. Provider chain: requested/default provider first, then every configured fallback.
  let chain;
  try {
    chain = getProviderChain(env, request.headers.get('X-Recognition-Provider'), { hasSignature, hasAudio });
  } catch (err) {
    return jsonError(`Provider initialization failed: ${err.message}`, 500, corsHeaders);
  }

  // 5. Try each provider until one identifies the song. A clean "no match" from any provider
  //    is a normal 200 answer (the client retries with more audio); only when every provider
  //    failed outright does the client get an error status.
  const failures = [];
  let noMatch = null;
  for (const provider of chain) {
    try {
      const result = await provider.recognize(hasAudio ? audioBuffer : null, { signatureUri, samplems });
      if (result && result.success) {
        if (provider !== chain[0]) {
          result.fallback = true;
          result.fallbackFrom = chain[0].name;
        }
        return jsonOk(result, corsHeaders);
      }
      if (!noMatch) noMatch = result;
    } catch (err) {
      failures.push({ provider: provider.name, message: String(err && err.message || err), upstreamStatus: err && err.upstreamStatus });
    }
  }

  if (noMatch) {
    return jsonOk({ ...noMatch, success: false, triedProviders: chain.map((p) => p.name) }, corsHeaders);
  }

  // Every provider errored. 429 upstream -> tell the client to back off; otherwise a gateway error.
  const rateLimited = failures.some((f) => f.upstreamStatus === 429);
  const detail = failures.map((f) => `${f.provider}: ${f.message}`).join(' | ');
  return jsonError(
    rateLimited
      ? 'The recognition service is busy right now. Please try again in a few seconds.'
      : `Recognition service error: ${detail || 'no provider available'}`,
    rateLimited ? 429 : 502,
    corsHeaders
  );
}

function jsonOk(body, corsHeaders) {
  return new Response(JSON.stringify({ error: false, ...body }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders }
  });
}
