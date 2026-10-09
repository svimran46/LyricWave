/**
 * Unit tests for lyric translation (translate.js) with a mocked MyMemory API.
 */

import { translateLines, uniqueLines, isUntranslatable, isUsefulTranslation, linesOf, TranslationQuotaError } from './translate.js';

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

function mockFetch(dictionary, calls) {
  return async (url) => {
    const q = new URL(url).searchParams.get('q');
    calls.push(q);
    const translatedText = dictionary[q] ?? q;
    return {
      ok: true,
      status: 200,
      json: async () => ({ responseStatus: 200, responseData: { translatedText } })
    };
  };
}

console.log('--- Testing Lyric Translation ---');

assert(isUntranslatable('♪') && isUntranslatable('...') && isUntranslatable(''), 'Music notes and punctuation are skipped');
assert(!isUntranslatable('Hola'), 'Words are translatable');
assert(uniqueLines(['a b', 'a b', '♪', '', 'c']).join('|') === 'a b|c', 'Repeated chorus lines are deduplicated');
assert(!isUsefulTranslation('Hello', 'hello'), 'Echoed translation is hidden');
assert(isUsefulTranslation('Hola', 'Hello'), 'Real translation is shown');
assert(linesOf({ status: 'synced', syncedLines: [{ text: 'x' }, { text: '' }] }).length === 2, 'Synced lines map 1:1');
assert(linesOf({ status: 'plain', plainLyrics: 'a\nb\nc' }).length === 3, 'Plain lyrics split by line');
assert(linesOf({ status: 'instrumental' }).length === 0, 'Instrumental has nothing to translate');

{
  const calls = [];
  const lines = ['Te quiero', '♪', 'Te quiero', 'Mi amor', 'Shakira'];
  const out = await translateLines(lines, 'en', {
    fetchImpl: mockFetch({ 'Te quiero': 'I love you', 'Mi amor': 'My love &#39;n&#39; me' }, calls)
  });
  assert(out.length === lines.length, 'Output keeps one entry per input line');
  assert(out[0] === 'I love you' && out[2] === 'I love you', 'Chorus repeats reuse one translation');
  assert(calls.filter((q) => q === 'Te quiero').length === 1, 'Chorus is requested only once');
  assert(out[1] === '', 'Music note line stays empty');
  assert(out[3] === "My love 'n' me", 'HTML entities are decoded');
  assert(out[4] === '', 'Untranslated names are hidden');
}

{
  const quotaFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ responseStatus: 429, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } })
  });
  let threw = false;
  try {
    await translateLines(['Hola'], 'en', { fetchImpl: quotaFetch });
  } catch (err) {
    threw = err instanceof TranslationQuotaError;
  }
  assert(threw, 'Daily quota surfaces as TranslationQuotaError');
}

{
  const errorFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const out = await translateLines(['Hola'], 'en', { fetchImpl: errorFetch });
  assert(out[0] === '', 'Server errors leave the original line alone');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
