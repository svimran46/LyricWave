/**
 * Unit Test for Serverless Recognition Provider Layer & ACRCloud Implementation
 */

import { ACRCloudProvider } from './functions/api/providers/acrcloud.js';
import { AudDProvider } from './functions/api/providers/audd.js';
import { ShazamProvider } from './functions/api/providers/shazam.js';
import { getRecognitionProvider } from './functions/api/providers/index.js';
import { parseWavTo16kSamples, encode16kWav, generateShazamSignature, DecodedMessage } from './functions/api/providers/shazam-signature.js';

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
  // 1. Signature generation verification (ACRCloud)
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
    ACR_ACCESS_SECRET: 'test_sec_456',
    AUDD_API_TOKEN: 'custom_audd_token_789'
  };

  const provider = getRecognitionProvider(mockEnv, 'acrcloud');
  assert(provider instanceof ACRCloudProvider, 'Factory instantiates ACRCloudProvider');
  assert(provider.host === 'identify-eu-west-1.acrcloud.com', 'Host trimmed and normalized');
  assert(provider.accessKey === 'test_key_123', 'Access key correctly populated from env');

  const auddProvider = getRecognitionProvider(mockEnv, 'audd');
  assert(auddProvider instanceof AudDProvider, 'Factory instantiates AudDProvider');
  assert(auddProvider.apiToken === 'custom_audd_token_789', 'AudD API token correctly populated from env');

  const auddDefaultProvider = getRecognitionProvider({ RECOGNITION_PROVIDER: 'audd' });
  assert(auddDefaultProvider instanceof AudDProvider, 'Factory respects RECOGNITION_PROVIDER=audd env setting');
  assert(auddDefaultProvider.apiToken === 'test', 'AudD defaults to "test" token when env not set');

  let throwsOnUnsupported = false;
  try {
    getRecognitionProvider(mockEnv, 'nonexistent');
  } catch {
    throwsOnUnsupported = true;
  }
  assert(throwsOnUnsupported, 'Throws error on unknown provider');

  // 3. Response normalization tests (ACRCloud)
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

  // 4. Multiple artists formatting (ACRCloud)
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

  // 5. Code 1001 (No match found) normalization (ACRCloud)
  const noMatchResponse = {
    status: { code: 1001, msg: 'No result' }
  };
  const normNoMatch = provider.normalizeResponse(noMatchResponse);
  assert(normNoMatch.success === false, 'Code 1001 normalized to success = false');
  assert(normNoMatch.title === null, 'Title is null on no match');
  assert(normNoMatch.confidence === 0, 'Confidence is 0 on no match');

  // 6. Error status handling (ACRCloud)
  let errorHandled = false;
  try {
    provider.normalizeResponse({ status: { code: 3001, msg: 'Missing access key' } });
  } catch (e) {
    errorHandled = true;
  }
  assert(errorHandled, 'Non-zero error code throws exception with API message');

  // ===================================================================
  // 7. AudD Timecode Parser & Response Normalization Tests
  // ===================================================================
  assert(AudDProvider.parseTimecodeToMs('01:23') === 83000, 'AudD parses MM:SS timecode (01:23 -> 83000ms)');
  assert(AudDProvider.parseTimecodeToMs('00:45.50') === 45500, 'AudD parses fractional MM:SS.sss (00:45.50 -> 45500ms)');
  assert(AudDProvider.parseTimecodeToMs('01:02:03') === 3723000, 'AudD parses HH:MM:SS timecode');
  assert(AudDProvider.parseTimecodeToMs(12.5) === 12500, 'AudD parses numeric seconds');
  assert(AudDProvider.parseTimecodeToMs(null) === null, 'AudD handles null timecode gracefully');

  // 8. AudD Success Response Normalization
  const sampleAuddSuccessResponse = {
    status: 'success',
    result: {
      artist: 'Daft Punk',
      title: 'Get Lucky',
      album: 'Random Access Memories',
      release_date: '2013-04-19',
      label: 'Columbia',
      timecode: '00:30',
      song_link: 'https://lis.tn/GetLucky',
      score: 100,
      spotify: {
        id: '2Foc5Q5nqNiosCNqttzHof',
        duration_ms: 248000
      },
      apple_music: {
        id: '636997447',
        durationInMillis: 248000
      }
    }
  };

  const normAudd = auddProvider.normalizeResponse(sampleAuddSuccessResponse);
  assert(normAudd.success === true, 'AudD successful match marked success = true');
  assert(normAudd.title === 'Get Lucky', 'AudD title correctly extracted');
  assert(normAudd.artist === 'Daft Punk', 'AudD artist correctly extracted');
  assert(normAudd.album === 'Random Access Memories', 'AudD album correctly extracted');
  assert(normAudd.duration === 248, 'AudD duration converted to seconds from spotify metadata');
  assert(normAudd.offsetMs === 30000, 'AudD offset parsed from timecode (00:30 -> 30000ms)');
  assert(normAudd.confidence === 100, 'AudD confidence score preserved');
  assert(normAudd.provider === 'audd', 'AudD provider stamped as audd');
  assert(normAudd.raw.spotifyTrackId === '2Foc5Q5nqNiosCNqttzHof', 'AudD spotify track ID extracted');
  assert(normAudd.raw.appleMusicId === '636997447', 'AudD Apple Music ID extracted');
  assert(normAudd.raw.songLink === 'https://lis.tn/GetLucky', 'AudD song link extracted');

  // 9. AudD No Match (result: null)
  const normAuddNoMatch = auddProvider.normalizeResponse({
    status: 'success',
    result: null
  });
  assert(normAuddNoMatch.success === false, 'AudD result=null normalized to success = false');
  assert(normAuddNoMatch.title === null, 'AudD title is null on no match');
  assert(normAuddNoMatch.confidence === 0, 'AudD confidence is 0 on no match');

  // 10. AudD API Error Response
  let auddErrorCaught = false;
  try {
    auddProvider.normalizeResponse({
      status: 'error',
      error: {
        error_code: 900,
        error_message: 'Wrong API token'
      }
    });
  } catch (err) {
    auddErrorCaught = err.message.includes('Wrong API token');
  }
  assert(auddErrorCaught, 'AudD API error response throws descriptive exception');

  // ===================================================================
  // 11. Shazam Provider Factory & Recognition Tests
  // ===================================================================
  const shazamProvider = getRecognitionProvider({}, 'shazam');
  assert(shazamProvider instanceof ShazamProvider, 'Factory instantiates ShazamProvider');
  assert(shazamProvider.name === 'shazam', 'Shazam provider name is "shazam"');

  const shazamEnvProvider = getRecognitionProvider({ RECOGNITION_PROVIDER: 'shazam' });
  assert(shazamEnvProvider instanceof ShazamProvider, 'Factory respects RECOGNITION_PROVIDER=shazam env setting');

  // 12. WAV encoder and parser roundtrip
  const synthSamples = new Int16Array(16000 * 2); // 2 seconds of 16kHz audio
  for (let i = 0; i < synthSamples.length; i++) {
    synthSamples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 16000);
  }
  const wavBytes = encode16kWav(synthSamples);
  assert(wavBytes.length === 44 + synthSamples.length * 2, 'WAV bytes have valid 44-byte header + data length');
  assert(wavBytes[0] === 0x52 && wavBytes[1] === 0x49 && wavBytes[2] === 0x46 && wavBytes[3] === 0x46, 'WAV starts with RIFF magic');

  const parsedSamples = parseWavTo16kSamples(wavBytes);
  assert(parsedSamples !== null && parsedSamples.length === synthSamples.length, 'parseWavTo16kSamples extracts matching sample count');
  assert(parsedSamples[100] === synthSamples[100], 'Parsed sample values match encoded sample values');

  // 13. Shazam signature generation & serialization
  // Test note burst with sharp attack for acoustic peak detection
  const musicalNotes = new Int16Array(16000 * 4);
  for (let s = 0; s < 16000 * 4; s++) {
    const t = s / 16000;
    const env = Math.exp(-(s % 4000) / 1000);
    musicalNotes[s] = Math.round(Math.sin(2 * Math.PI * 523.25 * t) * 25000 * env);
  }
  const wavNotes = encode16kWav(musicalNotes);
  const sigResult = generateShazamSignature(wavNotes);

  assert(typeof sigResult.uri === 'string', 'generateShazamSignature generates a string URI');
  assert(sigResult.uri.startsWith('data:audio/vnd.shazam.sig;base64,'), 'URI has valid data:audio/vnd.shazam.sig;base64, prefix');
  assert(sigResult.samplems > 0, 'samplems is positive duration');

  // 14. Signature round-trip decode verification
  const decodedMsg = DecodedMessage.decodeFromUri(sigResult.uri);
  assert(decodedMsg.sampleRateHz === 16000, 'Decoded signature preserves 16000 Hz sample rate');
  assert(decodedMsg.numberSamples > 0, 'Decoded signature has valid sample count');

  // 15. Shazam Success Response Normalization
  const sampleShazamSuccessResponse = {
    matches: [
      {
        id: '12345678',
        offset: 42.5,
        timeskew: 0.002
      }
    ],
    track: {
      key: '54321',
      title: 'Blinding Lights',
      subtitle: 'The Weeknd',
      sections: [
        {
          type: 'SONG',
          metadata: [
            { title: 'Album', text: 'After Hours' },
            { title: 'Released', text: '2020' },
            { title: 'Label', text: 'Republic Records' }
          ]
        }
      ],
      hub: {
        providers: [
          {
            type: 'SPOTIFY',
            actions: [
              { uri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b' }
            ]
          }
        ]
      },
      myshazam: {
        apple: {
          actions: [
            { uri: 'https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378607&uo=4' }
          ]
        }
      },
      images: {
        coverart: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/cover.jpg'
      }
    }
  };

  const normShazam = shazamProvider.normalizeResponse(sampleShazamSuccessResponse);
  assert(normShazam.success === true, 'Shazam successful match marked success = true');
  assert(normShazam.title === 'Blinding Lights', 'Shazam title extracted as Blinding Lights');
  assert(normShazam.artist === 'The Weeknd', 'Shazam artist extracted as The Weeknd');
  assert(normShazam.album === 'After Hours', 'Shazam album extracted as After Hours');
  assert(normShazam.offsetMs === 42500, 'Shazam offset extracted in ms (42.5s -> 42500ms)');
  assert(normShazam.confidence === 98, 'Shazam confidence computed from timeskew (98)');
  assert(normShazam.provider === 'shazam', 'Shazam provider stamped as shazam');
  assert(normShazam.raw.spotifyTrackId === '0VjIjW4GlUZAMYd2vXMi3b', 'Shazam extracts Spotify track ID');
  assert(normShazam.raw.coverArt !== null, 'Shazam extracts album cover art');
  assert(normShazam.lookupCandidates.some(c => c.title === 'Blinding Lights'), 'Shazam produces lyric lookup candidates');

  // 16. Shazam No Match Response
  const normShazamNoMatch = shazamProvider.normalizeResponse({
    matches: [],
    tagid: 'test-tag-id'
  });
  assert(normShazamNoMatch.success === false, 'Shazam empty matches marked success = false');
  assert(normShazamNoMatch.title === null, 'Shazam title is null on no match');
  assert(normShazamNoMatch.confidence === 0, 'Shazam confidence is 0 on no match');

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
}

runTests();

