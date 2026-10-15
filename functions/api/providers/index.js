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
  const selected = (providerName || env.RECOGNITION_PROVIDER || 'acrcloud').toLowerCase();

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
