/**
 * Shazam fingerprint + /api/recognize pipeline tests.
 *
 * - The fingerprint must be byte-identical to the reference implementation (SongRec/shazamio):
 *   the expected hash below was produced by shazamio's Python generator on the same signal.
 * - /api/recognize must answer a signature-only request through Shazam, report a clean miss
 *   as 200 (not 503), and fall back across providers.
 */

import { createHash } from 'node:crypto';
import {
  createSignatureFromPcm,
  DecodedMessage,
  isValidSignatureUri,
  samplemsFromUri,
  resampleTo16k,
  buildShazamRequest,
  normalizeShazamResponse
} from './shazam-core.js';
import { getProviderChain } from './functions/api/providers/index.js';
import { onRequestPost } from './functions/api/recognize.js';
import { makeShazamTestSignal } from './tests/fixtures/shazam-test-signal.js';

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

const REFERENCE = {
  sha256: 'b4cd97e2eaa9f8a76980c9b5c636863a96388e4cc2b4ac1d91b5cad5bce3b81d',
  uriLength: 3249,
  peaks: 463,
  numberSamples: 96000
};

async function run() {
  console.log('--- Shazam fingerprint ---');
  const signal = makeShazamTestSignal();
  const sig = createSignatureFromPcm(signal);
  const hash = createHash('sha256').update(sig.uri).digest('hex');
  assert(hash === REFERENCE.sha256, 'Signature is byte-identical to the shazamio reference');
  assert(sig.uri.length === REFERENCE.uriLength, `URI length matches reference (${sig.uri.length})`);
  assert(sig.peaks === REFERENCE.peaks, `Peak count matches reference (${sig.peaks})`);
  assert(sig.samplems === 6000, 'samplems is 6000 for 6 s of audio');

  const decoded = DecodedMessage.decodeFromUri(sig.uri);
  assert(decoded.numberSamples === REFERENCE.numberSamples, 'Decoded sample count round-trips');
  assert(decoded.peakCount() === REFERENCE.peaks, 'Decoded peaks round-trip');
  assert(decoded.encodeToUri() === sig.uri, 'Decode -> encode is lossless');
  assert(isValidSignatureUri(sig.uri), 'Valid signature passes the CRC check');
  const tampered = sig.uri.slice(0, -6) + (sig.uri.slice(-6, -5) === 'A' ? 'B' : 'A') + sig.uri.slice(-5);
  assert(!isValidSignatureUri(tampered), 'Corrupted signature fails the CRC check');
  assert(!isValidSignatureUri('data:audio/vnd.shazam.sig;base64,AAAA'), 'Garbage signature is rejected');
  assert(samplemsFromUri(sig.uri) === 6000, 'samplems can be read back from the signature');

  // Longer input keeps only the newest 12 s
  const long = new Int16Array(16000 * 20);
  long.set(signal, long.length - signal.length);
  assert(createSignatureFromPcm(long).samplems === 12000, 'Input over 12 s is trimmed to 12 s');

  // Fast enough for the browser main thread (the old generator needed ~300 ms for 8 s)
  createSignatureFromPcm(signal);
  const t0 = performance.now();
  createSignatureFromPcm(signal);
  const ms = performance.now() - t0;
  assert(ms < 250, `6 s fingerprint computed in ${ms.toFixed(1)} ms`);

  // Resampler keeps a 1 kHz tone and removes content above the new Nyquist
  const rate = 48000;
  const tone = new Float32Array(rate);
  const hiss = new Float32Array(rate);
  for (let i = 0; i < rate; i++) {
    tone[i] = Math.sin((2 * Math.PI * 1000 * i) / rate) * 0.5;
    hiss[i] = Math.sin((2 * Math.PI * 12000 * i) / rate) * 0.5;
  }
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const toneOut = resampleTo16k(tone, rate);
  assert(toneOut.length === 16000, 'Resampler output length is 16000 for 1 s');
  assert(Math.abs(rms(toneOut.subarray(200, -200)) - 0.3536) < 0.02, '1 kHz tone survives resampling');
  assert(rms(resampleTo16k(hiss, rate).subarray(200, -200)) < 0.02, '12 kHz content is filtered (no aliasing)');

  console.log('--- Shazam request / response ---');
  const req = buildShazamRequest({ uri: sig.uri, samplems: 6000 });
  assert(req.url.startsWith('https://amp.shazam.com/discovery/v5/en/US/android/-/tag/'), 'Request targets the Shazam tag endpoint');
  const body = JSON.parse(req.init.body);
  assert(body.signature.uri === sig.uri && body.signature.samplems === 6000, 'Request body carries the signature');
  const miss = normalizeShazamResponse({ matches: [], retryms: 4000 });
  assert(miss.success === false && miss.retryMs === 4000, 'Miss keeps the retry hint');
  const hit = normalizeShazamResponse({ matches: [{ offset: 10.5 }], track: { title: 'Song (Remastered)', subtitle: 'A & B' } });
  assert(hit.success && hit.offsetMs === 10500 && hit.offsetRef === 'start', 'Hit offset is start-anchored ms');
  assert(hit.lookupCandidates.some((c) => c.title === 'Song' && c.artist === 'A'), 'Lookup candidates include clean title + primary artist');

  console.log('--- Provider chain ---');
  const names = (chain) => chain.map((p) => p.name).join(',');
  assert(names(getProviderChain({}, null)) === 'shazam', 'No credentials: chain is just Shazam');
  assert(names(getProviderChain({}, 'acrcloud')) === 'shazam', 'Unconfigured ACRCloud request still gets Shazam');
  const acrEnv = { ACR_HOST: 'h', ACR_ACCESS_KEY: 'k', ACR_ACCESS_SECRET: 's' };
  assert(names(getProviderChain(acrEnv, null)) === 'shazam,acrcloud', 'Configured ACRCloud is a fallback');
  assert(names(getProviderChain(acrEnv, 'acrcloud')) === 'acrcloud,shazam', 'Requested provider goes first');
  assert(names(getProviderChain(acrEnv, null, { hasAudio: false })) === 'shazam', 'Signature-only request skips audio providers');
  assert(names(getProviderChain({ AUDD_API_TOKEN: 'test' }, null)) === 'shazam', 'AudD "test" token is not a fallback');

  console.log('--- /api/recognize ---');
  const realFetch = globalThis.fetch;
  const call = async (shazamReply, { form, headers = {}, env = {} } = {}) => {
    let upstream = 0;
    globalThis.fetch = async (url, init) => {
      upstream++;
      if (typeof shazamReply === 'function') return shazamReply(url, init);
      return new Response(JSON.stringify(shazamReply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const fd = form || (() => { const f = new FormData(); f.append('signature', sig.uri); f.append('samplems', '6000'); return f; })();
      const request = new Request('https://lyricwave.pages.dev/api/recognize', {
        method: 'POST',
        headers: { Origin: 'https://lyricwave.pages.dev', 'CF-Connecting-IP': `10.0.0.${Math.floor(Math.random() * 250)}`, ...headers },
        body: fd
      });
      const res = await onRequestPost({ request, env });
      return { status: res.status, json: await res.json(), upstream };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  let r = await call({ matches: [{ offset: 30 }], track: { title: 'Blinding Lights', subtitle: 'The Weeknd' } });
  assert(r.status === 200 && r.json.success === true && r.json.title === 'Blinding Lights', 'Signature-only request is identified via Shazam');
  assert(r.json.offsetMs === 30000 && r.json.offsetRef === 'start', 'Response carries a start-anchored offset');
  assert(r.upstream === 1, 'Exactly one upstream call');

  r = await call({ matches: [], retryms: 3000 });
  assert(r.status === 200 && r.json.success === false, 'Clean miss is a 200 no-match, not a 503');

  r = await call(() => new Response('blocked', { status: 403 }));
  assert(r.status === 502 && /shazam/i.test(r.json.message), 'Upstream failure is a 502 naming Shazam');

  r = await call(() => new Response('slow down', { status: 429 }));
  assert(r.status === 429, 'Upstream rate limit is passed on as 429');

  const empty = new FormData();
  empty.append('note', 'nothing');
  r = await call({}, { form: empty });
  assert(r.status === 400, 'Request without audio or signature is rejected');

  const badSig = new FormData();
  badSig.append('signature', 'data:audio/vnd.shazam.sig;base64,AAAA');
  r = await call({}, { form: badSig });
  assert(r.status === 400, 'Malformed signature without audio is rejected');

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
