/**
 * Lyric letter conversion & romanization engine for LyricWave.
 *
 * Converts non-Latin scripts (Cyrillic: Russian, Ukrainian, Kazakh, etc.,
 * Korean Hangul, Japanese Kana, Greek) into Latin/Roman letters so listeners
 * can read and sing along to the original words phonetically.
 *
 * - 100% client-side, zero latency, runs offline, no external API keys or rate limits.
 * - Detects script & language automatically (prioritizing Russian, Ukrainian, Kazakh).
 * - Leaves pure Latin/English lyrics untouched (no redundant duplicate lines).
 */

export const ROMANIZE_MODES = [
  ['auto', 'Auto-detect (RU, UK, KZ, etc.)'],
  ['ru', 'Russian (Русский → Latin)'],
  ['uk', 'Ukrainian (Українська → Latin)'],
  ['kk', 'Kazakh (Қазақша → Latin)'],
  ['cyrillic', 'All Cyrillic → Latin'],
  ['ko', 'Korean (Hangul → Romaja)'],
  ['ja', 'Japanese (Kana → Romaji)'],
  ['el', 'Greek (Ελληνικά → Latin)']
];

// Backwards-compatible alias for app.js settings dropdown
export const TRANSLATE_LANGUAGES = ROMANIZE_MODES;

export function defaultTargetLang() {
  return 'auto';
}

export class TranslationQuotaError extends Error {}

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when a line carries no letters (music notes ♪, punctuation, whitespace, numbers). */
export function isUntranslatable(text) {
  return !/\p{L}/u.test(String(text || ''));
}

/** Unique non-empty lines in first-seen order. */
export function uniqueLines(lines) {
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const text = String(raw || '').trim();
    if (!text || isUntranslatable(text) || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** Returns true if the romanized line is distinct from the original and worth showing. */
export function isUsefulTranslation(original, romanized) {
  if (!romanized) return false;
  return normalize(original) !== normalize(romanized);
}

// --- Cyrillic Romanization (Russian, Ukrainian, Kazakh) --------------------

const CYRILLIC_BASE = {
  'а': 'a', 'б': 'b', 'в': 'v', 'д': 'd', 'ж': 'zh', 'з': 'z',
  'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
  'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f',
  'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': "'",
  'ы': 'y', 'ь': "'", 'э': 'e', 'ю': 'yu', 'я': 'ya', 'ё': 'yo',
  // Belarusian, Serbian, Macedonian
  'ў': 'w', 'ј': 'j', 'љ': 'lj', 'њ': 'nj', 'ћ': 'c', 'ђ': 'dj', 'џ': 'dz'
};

const UKRAINIAN_EXTRA = {
  'г': 'h', 'ґ': 'g', 'е': 'e', 'є': 'ye', 'и': 'y', 'і': 'i', 'ї': 'yi'
};

const KAZAKH_EXTRA = {
  'ә': 'ä', 'ғ': 'ğ', 'қ': 'q', 'ң': 'ñ', 'ө': 'ö', 'ұ': 'u',
  'ү': 'ü', 'һ': 'h', 'і': 'i'
};

/** Detects whether Cyrillic text is Kazakh, Ukrainian, or Russian/General. */
export function detectCyrillicLang(text) {
  const str = String(text || '');
  if (/[әғқңөұүһӘҒҚҢӨҰҮҺ]/i.test(str)) return 'kk';
  if (/[єїґЄЇҐ]/i.test(str) || /[бвгґджзклмнпрстфхцчшщ][\'\’][яюєї]/i.test(str)) return 'uk';
  if (/[іїІЇ]/.test(str)) {
    // If it has Ukrainian-leaning letters
    return 'uk';
  }
  return 'ru';
}

/** Romanizes a single line containing Cyrillic characters. */
export function romanizeCyrillic(line, lang = 'auto') {
  if (!/[\u0400-\u04FF]/.test(line)) return line;
  const effectiveLang = (lang === 'auto' || lang === 'cyrillic') ? detectCyrillicLang(line) : lang;

  let result = '';
  const chars = Array.from(line);

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const lower = ch.toLowerCase();
    const isUpper = ch !== lower;
    const rawPrev = i > 0 ? chars[i - 1] : ' ';
    const prevLower = rawPrev.toLowerCase();
    const rawNext = i < chars.length - 1 ? chars[i + 1] : ' ';
    const isNextUpper = rawNext !== rawNext.toLowerCase() && rawNext.toLowerCase() !== rawNext.toUpperCase();
    const isPrevUpper = rawPrev !== rawPrev.toLowerCase() && rawPrev.toLowerCase() !== rawPrev.toUpperCase();

    let mapped = null;

    if (effectiveLang === 'uk') {
      if (lower in UKRAINIAN_EXTRA) {
        if (lower === 'є' && !/[\s\p{P}\p{S}]/u.test(prevLower) && !/[аеєиіїоуюя\u044A\u044C]/i.test(prevLower)) {
          mapped = 'ie';
        } else if (lower === 'ї') {
          mapped = (prevLower === 'и' || prevLower === 'y') ? 'i' : 'yi';
        } else {
          mapped = UKRAINIAN_EXTRA[lower];
        }
      }
    } else if (effectiveLang === 'kk') {
      if (lower in KAZAKH_EXTRA) {
        mapped = KAZAKH_EXTRA[lower];
      }
    }

    if (!mapped) {
      if (lower === 'е') {
        if (effectiveLang === 'ru') {
          const isWordStart = i === 0 || /[\s\p{P}\p{S}]/u.test(prevLower);
          const afterVowelOrSign = /[аеёиоуыэюяъь]/i.test(prevLower);
          mapped = (isWordStart || afterVowelOrSign) ? 'ye' : 'e';
        } else {
          mapped = 'e';
        }
      } else if (lower === 'г') {
        mapped = effectiveLang === 'uk' ? 'h' : 'g';
      } else if (lower === 'и') {
        mapped = effectiveLang === 'uk' ? 'y' : 'i';
      } else if (lower in CYRILLIC_BASE) {
        mapped = CYRILLIC_BASE[lower];
      }
    }

    if (mapped !== null) {
      if (isUpper) {
        if (mapped.length > 1 && (isNextUpper || isPrevUpper)) {
          result += mapped.toUpperCase();
        } else {
          result += mapped.charAt(0).toUpperCase() + mapped.slice(1);
        }
      } else {
        result += mapped;
      }
    } else {
      result += ch;
    }
  }

  return result;
}

// --- Korean Hangul Romanization (Revised Romanization) ---------------------

const HANGUL_L = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const HANGUL_V = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const HANGUL_T = ['', 'k', 'kk', 'ks', 'n', 'nj', 'nh', 't', 'l', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'p', 'ps', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', 'h'];

export function romanizeHangul(text) {
  return Array.from(String(text || '')).map((ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const idx = code - 0xAC00;
      const l = Math.floor(idx / 588);
      const v = Math.floor((idx % 588) / 28);
      const t = idx % 28;
      return HANGUL_L[l] + HANGUL_V[v] + HANGUL_T[t];
    }
    return ch;
  }).join('');
}

// --- Japanese Kana Romanization (Hepburn) ----------------------------------

const HIRAGANA_MAP = {
  'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
  'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
  'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
  'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
  'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
  'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
  'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
  'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
  'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
  'わ': 'wa', 'を': 'o', 'ん': 'n',
  'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
  'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
  'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
  'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
  'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
  'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
  'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
  'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
  'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
  'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
  'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
  'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
  'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
  'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
  'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
  'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo'
};

function toHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0x60));
}

export function romanizeKana(text) {
  let hira = toHiragana(String(text || ''));
  let out = '';
  for (let i = 0; i < hira.length; i++) {
    const pair = hira.slice(i, i + 2);
    if (HIRAGANA_MAP[pair]) {
      out += HIRAGANA_MAP[pair];
      i++;
      continue;
    }
    const ch = hira[i];
    if (ch === 'っ') {
      const next = hira[i + 1] ? (HIRAGANA_MAP[hira.slice(i + 1, i + 3)] || HIRAGANA_MAP[hira[i + 1]] || '') : '';
      out += next.charAt(0) || 't';
      continue;
    }
    if (ch === 'ー') {
      const last = out.charAt(out.length - 1);
      out += /[aeiou]/.test(last) ? last : '-';
      continue;
    }
    out += HIRAGANA_MAP[ch] || ch;
  }
  return out;
}

// --- Greek Romanization ----------------------------------------------------

const GREEK_MAP = {
  'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z',
  'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm',
  'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's',
  'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o',
  'ά': 'a', 'έ': 'e', 'ή': 'i', 'ί': 'i', 'ό': 'o', 'ύ': 'y', 'ώ': 'o'
};

export function romanizeGreek(text) {
  return Array.from(String(text || '')).map((ch) => {
    const lower = ch.toLowerCase();
    const mapped = GREEK_MAP[lower];
    if (!mapped) return ch;
    if (ch !== lower) {
      return mapped.charAt(0).toUpperCase() + mapped.slice(1);
    }
    return mapped;
  }).join('');
}

// --- Master Romanization Functions -----------------------------------------

/**
 * Romanize a single lyric line based on mode (auto, ru, uk, kk, ko, ja, el).
 * Returns the converted string, or empty string '' if no conversion is needed.
 */
export function romanizeLine(text, mode = 'auto') {
  const raw = String(text || '').trim();
  if (!raw || isUntranslatable(raw)) return '';

  let converted = raw;

  if (mode === 'ko' || (mode === 'auto' && /[\uAC00-\uD7AF]/.test(raw))) {
    converted = romanizeHangul(converted);
  }
  if (mode === 'ja' || (mode === 'auto' && /[\u3040-\u309F\u30A0-\u30FF]/.test(raw))) {
    converted = romanizeKana(converted);
  }
  if (mode === 'el' || (mode === 'auto' && /[\u0370-\u03FF]/.test(raw))) {
    converted = romanizeGreek(converted);
  }
  if (/[\u0400-\u04FF]/.test(converted)) {
    converted = romanizeCyrillic(converted, mode);
  }

  return isUsefulTranslation(raw, converted) ? converted : '';
}

/**
 * Transliterates an array of lyric lines. Returns an array of identical length,
 * with '' wherever no letter conversion is needed.
 */
export async function translateLines(lines, targetLang = 'auto') {
  if (!Array.isArray(lines)) return [];

  // If auto-detecting, check the whole song context to identify language (Kazakh / Ukrainian / Russian)
  let resolvedMode = targetLang;
  if (targetLang === 'auto' || targetLang === 'cyrillic') {
    const joined = lines.join(' ');
    if (/[әғқңөұүһӘҒҚҢӨҰҮҺ]/i.test(joined)) {
      resolvedMode = 'kk';
    } else if (/[єїґЄЇҐ]/i.test(joined) || /[бвгґджзклмнпрстфхцчшщ][\'\’][яюєї]/i.test(joined)) {
      resolvedMode = 'uk';
    } else if (/[іїІЇ]/.test(joined)) {
      resolvedMode = 'uk';
    } else if (/[\u0400-\u04FF]/.test(joined)) {
      resolvedMode = 'ru';
    }
  }

  const map = new Map();
  for (const raw of uniqueLines(lines)) {
    map.set(raw, romanizeLine(raw, resolvedMode));
  }

  return lines.map((line) => {
    const trimmed = String(line || '').trim();
    return map.get(trimmed) || '';
  });
}

export function linesOf(lyrics) {
  if (!lyrics) return [];
  if (lyrics.status === 'synced') return lyrics.syncedLines.map((l) => l.text || '');
  if (lyrics.status === 'plain') return String(lyrics.plainLyrics || '').split('\n');
  return [];
}

export function translationCacheKey(lyrics, targetLang) {
  const id = lyrics.lrclibId || (lyrics.syncedLines?.[0]?.text || lyrics.plainLyrics || '').slice(0, 80);
  return `${id}__${targetLang}`;
}

/**
 * Convert letters of a fetchLyrics() result. Instant, offline, and non-blocking.
 */
export async function translateLyrics(lyrics, targetLang = 'auto') {
  const lines = linesOf(lyrics);
  if (lines.length === 0) return [];
  return translateLines(lines, targetLang);
}

// Aliases
export const romanizeLyrics = translateLyrics;
export const romanizeLines = translateLines;
