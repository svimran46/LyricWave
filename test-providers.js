/**
 * Unit Test for Serverless Recognition Provider Layer & ACRCloud Implementation
 */

import { ACRCloudProvider } from './functions/api/providers/acrcloud.js';
import { getRecognitionProvider } from './functions/api/providers/index.js';

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${desc}`);
  }
}

console.log('--- Testing Audio Recognition Provider Layer ---');

async function runTests() {
  // 1. Signature generation verification
  const stringToSign = 'POST\n/v1/identify\ntestkey\naudio\n1\n1600000000';
  const secret = 'testsecret';
  const sig = await ACRCloudProvider.generateSignature(stringToSign, secret);
  
  assert(typeof sig === 'string' && sig.length > 0, 'Generates valid base64 HMAC-SHA1 signature');

  // Verify consistency
  const sig2 = await ACRCloudProvider.generateSignature(stringToSign, secret);
  assert(sig === sig2, 'HMAC-SHA1 signature is deterministic');

  // 2. Provider factory tests
  const mockEnv = {
    ACR_HOST: 'identify-eu-west-1.acrcloud.com',
    ACR_ACCESS_KEY: 'test_key_123',
    ACR_ACCESS_SECRET: 'test_sec_456'
  };

  const provider = getRecognitionProvider(mockEnv, 'acrcloud');
  assert(provider instanceof ACRCloudProvider, 'Factory instantiates ACRCloudProvider');
  assert(provider.host === 'identify-eu-west-1.acrcloud.com', 'Host trimmed and normalized');
  assert(provider.accessKey === 'test_key_123', 'Access key correctly populated from env');

  let throwsOnUnsupported = false;
  try {
    getRecognitionProvider(mockEnv, 'nonexistent');
  } catch {
    throwsOnUnsupported = true;
  }
  assert(throwsOnUnsupported, 'Throws error on unknown provider');

  // 3. Response normalization tests
  const sampleSuccessAcrResponse = {
    status: { code: 0, msg: 'Success' },
    metadata: {
      music: [
        {
          title: 'Midnight City',
          artists: [{ name: 'M83' }],
          album: { name: 'Hurry Up, We\'re Dreaming' },
          duration_ms: 243000,
          score: 100,
          play_offset_ms: 45200,
          acrid: 'test_acrid_1',
          external_metadata: {
            spotify: { track: { id: 'spotify_track_123' } }
          }
        }
      ]
    }
  };

  const normalized = provider.normalizeResponse(sampleSuccessAcrResponse);
  assert(normalized.success === true, 'Successful match marked success = true');
  assert(normalized.title === 'Midnight City', 'Title normalized to Midnight City');
  assert(normalized.artist === 'M83', 'Artist normalized to M83');
  assert(normalized.album === 'Hurry Up, We\'re Dreaming', 'Album name correctly extracted');
  assert(normalized.duration === 243, 'Duration converted to seconds (243s)');
  assert(normalized.offsetMs === 45200, 'Offset extracted in ms (45200ms)');
  assert(normalized.confidence === 100, 'Confidence score extracted (100)');
  assert(normalized.provider === 'acrcloud', 'Provider stamped as acrcloud');
  assert(normalized.raw.spotifyTrackId === 'spotify_track_123', 'Spotify track id preserved in raw metadata');

  // 4. Multiple artists formatting
  const multiArtistResponse = {
    status: { code: 0, msg: 'Success' },
    metadata: {
      music: [
        {
          title: 'Stay',
          artists: [{ name: 'The Kid LAROI' }, { name: 'Justin Bieber' }],
          album: { name: 'F*CK LOVE 3' },
          duration_ms: 141000,
          score: 98,
          db_begin_time_offset_ms: 12000
        }
      ]
    }
  };
  const normMulti = provider.normalizeResponse(multiArtistResponse);
  assert(normMulti.artist === 'The Kid LAROI, Justin Bieber', 'Multiple artists joined by comma');
  assert(normMulti.offsetMs === 12000, 'Fallback to db_begin_time_offset_ms works');

  // 5. Code 1001 (No match found) normalization
  const noMatchResponse = {
    status: { code: 1001, msg: 'No result' }
  };
  const normNoMatch = provider.normalizeResponse(noMatchResponse);
  assert(normNoMatch.success === false, 'Code 1001 normalized to success = false');
  assert(normNoMatch.title === null, 'Title is null on no match');
  assert(normNoMatch.confidence === 0, 'Confidence is 0 on no match');

  // 6. Error status handling
  let errorHandled = false;
  try {
    provider.normalizeResponse({ status: { code: 3001, msg: 'Missing access key' } });
  } catch (e) {
    errorHandled = true;
  }
  assert(errorHandled, 'Non-zero error code throws exception with API message');

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
}

runTests();
