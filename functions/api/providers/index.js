/**
 * Provider Registry & Factory
 * 
 * Allows dynamically selecting the active recognition provider
 * via environment variables or request headers.
 */

import { ACRCloudProvider } from './acrcloud.js';

export function getRecognitionProvider(env, providerName = 'acrcloud') {
  const selected = (providerName || env.RECOGNITION_PROVIDER || 'acrcloud').toLowerCase();

  switch (selected) {
    case 'acrcloud':
      return new ACRCloudProvider({
        host: env.ACR_HOST,
        accessKey: env.ACR_ACCESS_KEY,
        accessSecret: env.ACR_ACCESS_SECRET
      });

    default:
      throw new Error(`Unsupported audio recognition provider: "${selected}".`);
  }
}
