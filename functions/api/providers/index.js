/**
 * Provider Registry & Factory
 * 
 * Allows dynamically selecting the active recognition provider
 * via environment variables or request headers.
 * 
 * Supported Providers:
 * - 'shazam': Native Shazam acoustic fingerprinting (no API keys or quota limits)
 * - 'acrcloud': ACRCloud HMAC-SHA1 identification
 * - 'audd': AudD REST music identification
 */

import { ACRCloudProvider } from './acrcloud.js';
import { AudDProvider } from './audd.js';
import { ShazamProvider } from './shazam.js';

export { ACRCloudProvider, AudDProvider, ShazamProvider };

export function getRecognitionProvider(env = {}, providerName = null) {
  const selected = String(providerName || env.RECOGNITION_PROVIDER || 'shazam').toLowerCase();

  switch (selected) {
    case 'shazam':
      return new ShazamProvider({
        timezone: env.SHAZAM_TIMEZONE || 'UTC',
        endpoint: env.SHAZAM_ENDPOINT
      });

    case 'acrcloud':
      return new ACRCloudProvider({
        host: env.ACR_HOST,
        accessKey: env.ACR_ACCESS_KEY,
        accessSecret: env.ACR_ACCESS_SECRET
      });

    case 'audd':
      return new AudDProvider({
        apiToken: env.AUDD_API_TOKEN,
        endpoint: env.AUDD_ENDPOINT
      });

    default:
      throw new Error(`Unsupported audio recognition provider: "${selected}".`);
  }
}

export const PROVIDER_NAMES = ['shazam', 'acrcloud', 'audd'];

/**
 * Ordered provider chain for one request: the requested (or env default) provider first, then
 * every other provider that is configured. Shazam is always available (no credentials), so the
 * chain is never empty and an unconfigured ACRCloud/AudD never turns into a 503.
 *
 * @param {Object} env
 * @param {string|null} requested
 * @param {{ hasSignature?: boolean, hasAudio?: boolean }} [input]
 */
export function getProviderChain(env = {}, requested = null, input = {}) {
  const hasAudio = input.hasAudio !== false;
  const preferred = String(requested || env.RECOGNITION_PROVIDER || 'shazam').toLowerCase();
  const order = [preferred, ...PROVIDER_NAMES.filter((n) => n !== preferred)];
  const chain = [];
  for (const name of order) {
    if (!PROVIDER_NAMES.includes(name)) continue;
    const provider = getRecognitionProvider(env, name);
    // Audio-based providers need the audio itself; skip them for signature-only requests.
    if (name !== 'shazam' && !hasAudio) continue;
    if (name !== 'shazam' && !provider.isConfigured()) continue;
    chain.push(provider);
  }
  return chain;
}
