/**
 * Provider Registry & Factory
 * 
 * Allows dynamically selecting the active recognition provider
 * via environment variables or request headers.
 */

import { ACRCloudProvider } from './acrcloud.js';
import { AudDProvider } from './audd.js';

export function getRecognitionProvider(env, providerName = null) {
  const selected = (providerName || env.RECOGNITION_PROVIDER || 'acrcloud').toLowerCase();

  switch (selected) {
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

