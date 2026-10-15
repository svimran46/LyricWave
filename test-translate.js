/**
 * Unit tests for lyric letter conversion & romanization (translate.js).
 */

import {
  translateLines,
  translateLyrics,
  uniqueLines,
  isUntranslatable,
  isUsefulTranslation,
  linesOf,
  romanizeLine,
  romanizeCyrillic,
  romanizeHangul,
  romanizeKana,
  romanizeGreek,
  detectCyrillicLang
} from './translate.js';

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

console.log('--- Testing Lyric Letter Conversion & Romanization ---');

// Basic utilities
assert(isUntranslatable('♪') && isUntranslatable('...') && isUntranslatable(''), 'Music notes and punctuation are skipped');
assert(!isUntranslatable('Привет'), 'Words are translatable/convertible');
assert(uniqueLines(['Привет', 'Привет', '♪', '', 'Мир']).join('|') === 'Привет|Мир', 'Repeated chorus lines are deduplicated');
assert(!isUsefulTranslation('Hello', 'Hello'), 'Unchanged Latin lines are not useful');
assert(isUsefulTranslation('Привет', 'Privet'), 'Converted romanized lines are useful');
assert(linesOf({ status: 'synced', syncedLines: [{ text: 'x' }, { text: '' }] }).length === 2, 'Synced lines map 1:1');
assert(linesOf({ status: 'plain', plainLyrics: 'a\nb\nc' }).length === 3, 'Plain lyrics split by line');
assert(linesOf({ status: 'instrumental' }).length === 0, 'Instrumental has nothing to convert');

// Language detection
assert(detectCyrillicLang('Қазақстан') === 'kk', 'Detects Kazakh from specific letters');
assert(detectCyrillicLang('Сәлем') === 'kk', 'Detects Kazakh from ä');
assert(detectCyrillicLang('Доброго вечора, ми з України') === 'uk', 'Detects Ukrainian from ї');
assert(detectCyrillicLang('Київ') === 'uk', 'Detects Ukrainian from ї/і');
assert(detectCyrillicLang('Привет, как дела?') === 'ru', 'Detects Russian standard Cyrillic');

// Russian Cyrillic romanization
{
  const res1 = romanizeLine('Я люблю тебя, Россия!', 'ru');
  assert(res1 === 'Ya lyublyu tebya, Rossiya!', `Russian lyrics romanized correctly: got "${res1}"`);

  const res2 = romanizeLine('Европа и поезд едут', 'ru');
  assert(res2 === 'Yevropa i poyezd yedut', `Russian initial/vowel-following 'E' becomes 'Ye': got "${res2}"`);

  const res3 = romanizeLine('Звезда по имени Солнце', 'ru');
  assert(res3 === 'Zvezda po imeni Solntse', `Russian song title romanized: got "${res3}"`);

  const resCaps = romanizeLine('РОССИЯ', 'ru');
  assert(resCaps === 'ROSSIYA', `Russian all-caps romanized: got "${resCaps}"`);
}

// Ukrainian Cyrillic romanization
{
  const resUk1 = romanizeLine('Доброго вечора, ми з України', 'uk');
  assert(resUk1 === 'Dobroho vechora, my z Ukrayiny', `Ukrainian 'г' -> 'h', 'и' -> 'y', 'ї' -> 'yi': got "${resUk1}"`);

  const resUk2 = romanizeLine('Київ — наше місто', 'uk');
  assert(resUk2.startsWith('Kyiv'), `Ukrainian 'Київ' romanized as 'Kyiv': got "${resUk2}"`);

  const resUk3 = romanizeLine('Ой у лузі червона калина', 'uk');
  assert(resUk3.includes('chervona kalyna'), `Ukrainian 'калина' -> 'kalyna': got "${resUk3}"`);

  const resUkCaps = romanizeLine('УКРАЇНА', 'uk');
  assert(resUkCaps === 'UKRAYINA', `Ukrainian all-caps preserved: got "${resUkCaps}"`);
}

// Kazakh Cyrillic romanization
{
  const resKz1 = romanizeLine('Қазақстан — менің Отаным!', 'kk');
  assert(resKz1 === 'Qazaqstan — meniñ Otanym!', `Kazakh 'Қ' -> 'Q', 'ң' -> 'ñ': got "${resKz1}"`);

  const resKz2 = romanizeLine('Сәлем, жаным, өмір қандай?', 'kk');
  assert(resKz2 === 'Sälem, zhanym, ömir qanday?', `Kazakh 'ә' -> 'ä', 'ө' -> 'ö': got "${resKz2}"`);

  const resKzCaps = romanizeLine('ҚАЗАҚСТАН', 'kk');
  assert(resKzCaps === 'QAZAQSTAN', `Kazakh all-caps: got "${resKzCaps}"`);
}

// Korean Hangul romanization
{
  const resKo = romanizeLine('사랑해', 'ko');
  assert(resKo === 'saranghae', `Korean Hangul algorithmic romanization: got "${resKo}"`);

  const resKo2 = romanizeLine('보고 싶다', 'ko');
  assert(resKo2 === 'bogo sipda', `Korean '보고 싶да' -> 'bogo sipda': got "${resKo2}"`);
}

// Japanese Kana romanization
{
  const resJa = romanizeLine('ありがとう', 'ja');
  assert(resJa === 'arigatou', `Japanese Hiragana romanization: got "${resJa}"`);

  const resJaKata = romanizeLine('トーキョー', 'ja');
  assert(resJaKata.includes('tookyoo') || resJaKata.includes('tokyo'), `Japanese Katakana romanized: got "${resJaKata}"`);
}

// Greek romanization
{
  const resEl = romanizeLine('Καλημέρα', 'el');
  assert(resEl === 'Kalimera', `Greek romanization: got "${resEl}"`);
}

// Chinese Hanzi / Pinyin romanization
{
  const resZh = romanizeLine('我爱你中国', 'zh');
  assert(resZh === 'wo ai ni zhong guo', `Chinese lyrics romanized to Pinyin: got "${resZh}"`);

  const resZhAuto = romanizeLine('你是我心中的歌', 'auto');
  assert(resZhAuto.includes('ni') && resZhAuto.includes('wo'), `Chinese auto-detection Pinyin: got "${resZhAuto}"`);
}

// Hindi / Devanagari romanization
{
  const resHi = romanizeLine('तुम ही हो', 'hi');
  assert(resHi === 'tum hee ho', `Hindi Devanagari romanized: got "${resHi}"`);

  const resHiAuto = romanizeLine('नमस्ते', 'auto');
  assert(resHiAuto === 'namaste', `Hindi auto-detection: got "${resHiAuto}"`);
}

// Arabic & Persian romanization
{
  const resAr = romanizeLine('حبيبي', 'ar');
  assert(resAr === 'hbibi', `Arabic romanized: got "${resAr}"`);

  const resAr2 = romanizeLine('موسيقى', 'auto');
  assert(resAr2 === 'musiqa', `Arabic auto-detection: got "${resAr2}"`);
}

// Hebrew romanization
{
  const resHe = romanizeLine('שלום', 'he');
  assert(resHe === 'shlom', `Hebrew romanized: got "${resHe}"`);
}

// Thai romanization
{
  const resTh = romanizeLine('สวัสดี', 'th');
  assert(resTh === 'swasdee', `Thai romanized: got "${resTh}"`);
}

// Georgian romanization
{
  const resKa = romanizeLine('გამარჯობა', 'ka');
  assert(resKa === 'gamarjoba', `Georgian romanized: got "${resKa}"`);
}

// Armenian romanization
{
  const resHy = romanizeLine('Բարև', 'hy');
  assert(resHy === 'Barev', `Armenian romanized: got "${resHy}"`);
}

// Bengali romanization
{
  const resBn = romanizeLine('আমি তোমাকে ভালোবাসি', 'bn');
  assert(resBn === 'ami tomake bhalobashi', `Bengali romanized: got "${resBn}"`);
}

// Punjabi / Gurmukhi romanization
{
  const resPa = romanizeLine('ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ', 'pa');
  assert(resPa.includes('sat'), `Gurmukhi Punjabi romanized: got "${resPa}"`);
}

// Pure Latin / English is untouched (no redundant display)
{
  const english = romanizeLine('Never gonna give you up', 'auto');
  assert(english === '', 'English lyrics produce empty string (no duplicate displayed)');

  const spanish = romanizeLine('Despacito, quiero respirar tu cuello', 'auto');
  assert(spanish === '', 'Spanish lyrics produce empty string');
}

// Mixed Cyrillic + English
{
  const mixed = romanizeLine('Listen to my песню on Spotify', 'auto');
  assert(mixed === 'Listen to my pesnyu on Spotify', `Mixed English + Cyrillic handles both cleanly: got "${mixed}"`);
}

// Full lyrics batch processing
{
  const lines = [
    'Я люблю тебя',
    '♪',
    'Я люблю тебя',
    'Қазақстан алға',
    'Don\'t stop the music'
  ];
  const out = await translateLines(lines, 'auto');
  assert(out.length === lines.length, 'Output keeps one entry per input line');
  assert(out[0] === 'Ya lyublyu tebya', `Line 0 romanized: "${out[0]}"`);
  assert(out[1] === '', 'Music note line stays empty');
  assert(out[2] === 'Ya lyublyu tebya', 'Chorus repeats reuse romanization');
  assert(out[3] === 'Qazaqstan alğa', `Kazakh line romanized: "${out[3]}"`);
  assert(out[4] === '', 'Pure English line stays empty');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);


