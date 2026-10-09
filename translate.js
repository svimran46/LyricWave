/**
 * Lyric translation via the free MyMemory API (no key needed).
 *
 * - Called straight from the browser so each listener gets their own free daily quota.
 * - Lines are deduplicated first (choruses repeat), so a song costs far fewer characters.
 * - Results are cached in IndexedDB per song + target language, so a song is translated once per device.
 */

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
const MAX_QUERY_BYTES = 480; // MyMemory caps q at 500 bytes
const CONCURRENCY = 4;
const DB_NAME = 'lyricwave_translations';
const STORE_NAME = 'songs';

export const TRANSLATE_LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['tr', 'Turkish'], ['ru', 'Russian'],
  ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['ur', 'Urdu'],
  ['id', 'Indonesian'], ['ms', 'Malay'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)']
];

/** Best default target: the device language if we support it, else English. */
export function defaultTargetLang() {
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  const lower = nav.toLowerCase();
  if (lower.startsWith('zh')) return /tw|hk|hant/.test(lower) ? 'zh-TW' : 'zh-CN';
  const base = lower.split('-')[0];
  return TRANSLATE_LANGUAGES.some(([code]) => code === base) ? base : 'en';
}

export class TranslationQuotaError extends Error {}

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when a line carries no words worth translating (♪, punctuation, empty). */
export function isUntranslatable(text) {
  return !/\p{L}/u.test(String(text || ''));
}

/** Unique translatable lines, in first-seen order. */
export function uniqueLines(lines) {
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const text = String(raw || '').trim();
    if (!text || isUntranslatable(text) || seen.has(text)) continue;
    if (new TextEncoder().encode(text).length > MAX_QUERY_BYTES) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** A translation that only echoes the original (same language, names) is not worth showing. */
export function isUsefulTranslation(original, translated) {
  if (!translated) return false;
  return normalize(original) !== normalize(translated);
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function translateOne(text, targetLang, signal, fetchImpl) {
  const params = new URLSearchParams({ q: text, langpair: `autodetect|${targetLang}` });
  const res = await fetchImpl(`${MYMEMORY_URL}?${params.toString()}`, { signal });
  if (res.status === 429) throw new TranslationQuotaError('Free translation limit reached for today.');
  if (!res.ok) throw new Error(`Translation failed (HTTP ${res.status})`);
  const data = await res.json();
  const status = Number(data && data.responseStatus);
  const translated = data && data.responseData && data.responseData.translatedText;
  if (status === 429 || /MYMEMORY WARNING/i.test(translated || '')) {
    throw new TranslationQuotaError('Free translation limit reached for today.');
  }
  if (status && status !== 200) return '';
  return translated ? decodeEntities(translated).trim() : '';
}

/**
 * Translate an array of lyric lines. Returns an array the same length as `lines`,
 * with '' wherever there is nothing useful to show.
 */
export async function translateLines(lines, targetLang, options = {}) {
  return (await translateLinesDetailed(lines, targetLang, options)).lines;
}

async function translateLinesDetailed(lines, targetLang, { signal, fetchImpl = fetch } = {}) {
  const unique = uniqueLines(lines);
  const map = new Map();
  let quotaError = null;
  let next = 0;

  async function worker() {
    while (next < unique.length && !quotaError) {
      if (signal && signal.aborted) return;
      const text = unique[next++];
      try {
        map.set(text, await translateOne(text, targetLang, signal, fetchImpl));
      } catch (err) {
        if (err instanceof TranslationQuotaError) quotaError = err;
        else if (err && err.name === 'AbortError') return;
        else map.set(text, '');
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  if (quotaError && map.size === 0) throw quotaError;

  const out = lines.map((raw) => {
    const text = String(raw || '').trim();
    const translated = map.get(text) || '';
    return isUsefulTranslation(text, translated) ? translated : '';
  });
  return { lines: out, complete: !quotaError && !(signal && signal.aborted) };
}

// --- IndexedDB cache -------------------------------------------------------

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCached(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCached(key, value) {
  try {
    const db = await openDB();
    db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key);
  } catch { /* cache is best-effort */ }
}

export function translationCacheKey(lyrics, targetLang) {
  const id = lyrics.lrclibId || (lyrics.syncedLines?.[0]?.text || lyrics.plainLyrics || '').slice(0, 80);
  return `${id}__${targetLang}`;
}

/** The lines a lyrics result shows: synced lines, or the plain lyrics split by line. */
export function linesOf(lyrics) {
  if (!lyrics) return [];
  if (lyrics.status === 'synced') return lyrics.syncedLines.map((l) => l.text || '');
  if (lyrics.status === 'plain') return String(lyrics.plainLyrics || '').split('\n');
  return [];
}

/** Translate a fetchLyrics() result, using the device cache when possible. */
export async function translateLyrics(lyrics, targetLang, options = {}) {
  const lines = linesOf(lyrics);
  if (lines.length === 0) return [];
  const key = translationCacheKey(lyrics, targetLang);
  const cached = await getCached(key);
  if (Array.isArray(cached) && cached.length === lines.length) return cached;
  const { lines: translated, complete } = await translateLinesDetailed(lines, targetLang, options);
  // Only cache a full pass, so lines skipped by a quota stop get retried another day.
  if (complete && translated.some(Boolean)) setCached(key, translated);
  return translated;
}
