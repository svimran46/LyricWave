/**
 * LyricWave Lyrics Service (Phase 3)
 * 
 * Fetches synced lyrics from LRCLIB API (lrclib.net),
 * parses LRC timestamp formats, handles caching,
 * provides fallbacks for plain/instrumental tracks,
 * and manages user offset calibration.
 */

const LRCLIB_GET_URL = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';
const STORAGE_OFFSET_KEY = 'lyricwave_manual_offset_ms';
const STORAGE_CACHE_PREFIX = 'lyricwave_lrc_';

// 30 days expiry in milliseconds (30 * 24 * 60 * 60 * 1000)
const IDB_CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const DB_NAME = 'LyricWaveDB';
const DB_VERSION = 1;
const STORE_NAME = 'lyrics';

/**
 * Open or upgrade LyricWave IndexedDB instance
 */
function openLyricsDB() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Normalize artist and title into a robust cache key
 */
export function normalizeLyricCacheKey(artist, title) {
  const normArtist = String(artist || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const normTitle = cleanTrackTitle(String(title || ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return `${normArtist}__${normTitle}`.trim();
}

/**
 * Retrieve cached lyrics from IndexedDB (with 30-day expiry check)
 */
async function getIdbCachedLyrics(key) {
  const db = await openLyricsDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (entry && entry.cachedAt && (Date.now() - entry.cachedAt < IDB_CACHE_EXPIRY_MS)) {
          resolve(entry.data);
        } else {
          // Expired or missing
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Save lyrics to IndexedDB with timestamp
 */
async function setIdbCachedLyrics(key, data) {
  const db = await openLyricsDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({
      key,
      data,
      cachedAt: Date.now()
    });
  } catch {
    // Fail silently on private browsing / storage quota restrictions
  }
}

// In-memory runtime cache for rapid track switching
const memoryCache = new Map();

/**
 * Clean track title by removing common suffixes that hurt API match rates
 */
export function cleanTrackTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s*-\s*.*?(remaster(?:ed)?|deluxe|bonus|radio edit|live|mono|stereo|anniversary|edit|version|session(?:s)?).*$/i, '')
    .replace(/\s*\(feat\..*?\)/i, '')
    .replace(/\s*\(with.*?\)/i, '')
    .replace(/\s*\[feat\..*?\]/i, '')
    .replace(/\s*\(.*?(remaster(?:ed)?|deluxe|bonus|anniversary|session(?:s)?|live|edit|acoustic).*?\)/i, '')
    .trim();
}

/**
 * Parse raw LRC string into a sorted array of timed lyric objects
 * Returns: Array<{ timeMs: number, text: string }>
 */
export function parseLRC(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];

  const lines = lrcText.split('\n');
  const parsed = [];
  const timestampRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  let fileOffsetMs = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Check for [offset: +/- ms] metadata tag
    const offsetMatch = trimmed.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetMatch) {
      fileOffsetMs = parseInt(offsetMatch[1], 10) || 0;
      continue;
    }

    // Skip metadata tags (e.g. [ar:Artist], [ti:Title], [length:...])
    if (/^\[(ar|ti|al|by|length|re|ve):/i.test(trimmed)) {
      continue;
    }

    // Collect all timestamps in the line
    const timestamps = [];
    let match;
    while ((match = timestampRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      let ms = 0;

      if (match[3]) {
        // Handle 1, 2, or 3 digit fractions of seconds
        const fraction = match[3];
        if (fraction.length === 1) ms = parseInt(fraction, 10) * 100;
        else if (fraction.length === 2) ms = parseInt(fraction, 10) * 10;
        else ms = parseInt(fraction.slice(0, 3), 10);
      }

      timestamps.push(minutes * 60 * 1000 + seconds * 1000 + ms);
    }

    // Extract text portion after stripping all timestamp tags
    const text = trimmed.replace(timestampRegex, '').trim();

    // Map each timestamp to this text, adjusting for file [offset: ms]
    for (const timeMs of timestamps) {
      const adjustedTimeMs = Math.max(0, timeMs + fileOffsetMs);
      parsed.push({ timeMs: adjustedTimeMs, text });
    }
  }

  // Sort chronologically
  parsed.sort((a, b) => a.timeMs - b.timeMs);

  return parsed;
}

/**
 * Fetch lyrics from LRCLIB with multi-tier fallback (Exact GET -> Cleaned GET -> Search API)
 */
export async function fetchLyrics(track) {
  if (!track || !track.title) {
    return { status: 'none', message: 'No track provided' };
  }

  const rawArtistStr = String(track.artists || track.artist || '').trim();
  const primaryArtist = rawArtistStr.split(/,|\band\b|&|\bfeat\b\.?|\bwith\b/i)[0].trim() || rawArtistStr;
  const idbKey = normalizeLyricCacheKey(primaryArtist, track.title);
  const cacheKey = `${track.id || track.title}__${track.artists || track.artist}`.toLowerCase();

  // 1. Check in-memory cache
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey);
  }
  if (memoryCache.has(idbKey)) {
    return memoryCache.get(idbKey);
  }

  // 2. Check IndexedDB 30-day cache
  try {
    const idbCached = await getIdbCachedLyrics(idbKey);
    if (idbCached) {
      memoryCache.set(cacheKey, idbCached);
      memoryCache.set(idbKey, idbCached);
      return idbCached;
    }
  } catch (err) {
    console.warn('IndexedDB read error:', err);
  }

  // 3. Check localStorage cache fallback
  if (typeof localStorage !== 'undefined') {
    try {
      const cachedItem = localStorage.getItem(`${STORAGE_CACHE_PREFIX}${cacheKey}`);
      if (cachedItem) {
        const data = JSON.parse(cachedItem);
        memoryCache.set(cacheKey, data);
        memoryCache.set(idbKey, data);
        return data;
      }
    } catch (err) {
      console.warn('LocalStorage read error:', err);
    }
  }

  // 4. Fetch from LRCLIB
  const durationSec = Math.round((track.durationMs || 0) / 1000);

  let lyricResult = null;

  try {
    // Parallel fast-path: dispatch exact query, cleaned query, and search in parallel
    // with an 8-second timeout for mobile resilience
    const cleanedTitle = cleanTrackTitle(track.title);
    const fetchController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const fetchTimer = fetchController ? setTimeout(() => fetchController.abort(), 8000) : null;
    const fetchSignal = fetchController ? fetchController.signal : undefined;

    const queries = [];

    // Query 1: Clean exact GET query via /api/get (do NOT constrain by album_name or strict duration
    // as album titles vary across single/EP/album releases and cause 404s)
    const exactParams = new URLSearchParams({
      track_name: track.title,
      artist_name: primaryArtist
    });
    queries.push(
      fetch(`${LRCLIB_GET_URL}?${exactParams.toString()}`, { signal: fetchSignal })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    );

    // Query 2: Cleaned title query via /api/get (if title differs)
    if (cleanedTitle && cleanedTitle !== track.title) {
      const cleanParams = new URLSearchParams({
        track_name: cleanedTitle,
        artist_name: primaryArtist
      });
      queries.push(
        fetch(`${LRCLIB_GET_URL}?${cleanParams.toString()}`, { signal: fetchSignal })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      );
    }

    // Query 3: Search fallback via /api/search with primary artist
    const searchParams = new URLSearchParams({
      track_name: cleanedTitle || track.title,
      artist_name: primaryArtist
    });
    queries.push(
      fetch(`${LRCLIB_SEARCH_URL}?${searchParams.toString()}`, { signal: fetchSignal })
        .then(r => r.ok ? r.json() : null)
        .then(results => {
          if (Array.isArray(results) && results.length > 0) {
            return results.find(r => r.syncedLyrics)
              || results.find(r => r.plainLyrics)
              || results[0];
          }
          return null;
        })
        .catch(() => null)
    );

    // Query 4: Full-text query via /api/search?q=... (broadest coverage)
    const generalQ = `${primaryArtist} ${cleanedTitle || track.title}`.trim();
    const generalParams = new URLSearchParams({ q: generalQ });
    queries.push(
      fetch(`${LRCLIB_SEARCH_URL}?${generalParams.toString()}`, { signal: fetchSignal })
        .then(r => r.ok ? r.json() : null)
        .then(results => {
          if (Array.isArray(results) && results.length > 0) {
            return results.find(r => r.syncedLyrics)
              || results.find(r => r.plainLyrics)
              || results[0];
          }
          return null;
        })
        .catch(() => null)
    );

    // Query 5: Search fallback with full raw artist (if raw artist differs from primaryArtist)
    const rawArtist = (track.artist || track.artists || '').trim();
    if (rawArtist && rawArtist !== primaryArtist) {
      const rawSearchParams = new URLSearchParams({
        track_name: cleanedTitle || track.title,
        artist_name: rawArtist
      });
      queries.push(
        fetch(`${LRCLIB_SEARCH_URL}?${rawSearchParams.toString()}`, { signal: fetchSignal })
          .then(r => r.ok ? r.json() : null)
          .then(results => {
            if (Array.isArray(results) && results.length > 0) {
              return results.find(r => r.syncedLyrics)
                || results.find(r => r.plainLyrics)
                || results[0];
            }
            return null;
          })
          .catch(() => null)
      );
    }

    const outcomes = await Promise.allSettled(queries);
    if (fetchTimer) clearTimeout(fetchTimer);

    let isQuotaError = false;
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled' && outcome.value) {
        const candidate = outcome.value;
        if (candidate.status === 429) {
          isQuotaError = true;
        } else if (candidate.syncedLyrics) {
          lyricResult = candidate;
          break;
        } else if (!lyricResult && (candidate.plainLyrics || candidate.instrumental)) {
          lyricResult = candidate;
        }
      }
    }

    if (isQuotaError && !lyricResult) {
      return {
        status: 'quota',
        type: 'none',
        message: 'LRCLIB API rate limit exceeded (HTTP 429). Please wait a moment.',
        syncedLines: [],
        plainLyrics: ''
      };
    }
  } catch (fetchErr) {
    console.warn('LRCLIB network error:', fetchErr);
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return {
      status: 'error',
      type: 'none',
      message: isOffline
        ? 'You are currently offline. Connect to the internet to load new lyrics.'
        : `Network error reaching lyrics provider (${fetchErr.message || 'connection failed'}).`,
      syncedLines: [],
      plainLyrics: ''
    };
  }

  // 4. Process and format final lyrics result
  let processed;

  if (!lyricResult) {
    processed = {
      status: 'not_found',
      type: 'none',
      message: 'No lyrics found for this song on LRCLIB.',
      syncedLines: [],
      plainLyrics: ''
    };
  } else if (lyricResult.instrumental) {
    processed = {
      status: 'instrumental',
      type: 'instrumental',
      message: '🎷 Instrumental track — no lyrics available.',
      syncedLines: [],
      plainLyrics: ''
    };
  } else if (lyricResult.syncedLyrics) {
    const lines = parseLRC(lyricResult.syncedLyrics);
    processed = {
      status: 'synced',
      type: 'synced',
      syncedLines: lines,
      plainLyrics: lyricResult.plainLyrics || '',
      lrclibId: lyricResult.id
    };
  } else if (lyricResult.plainLyrics) {
    processed = {
      status: 'plain',
      type: 'plain',
      syncedLines: [],
      plainLyrics: lyricResult.plainLyrics,
      message: 'Plain lyrics available (unsynced).',
      lrclibId: lyricResult.id
    };
  } else {
    processed = {
      status: 'not_found',
      type: 'none',
      message: 'No lyrics found for this song on LRCLIB.',
      syncedLines: [],
      plainLyrics: ''
    };
  }

  // 5. Store in memory, IndexedDB (30-day), and persistent localStorage cache
  memoryCache.set(cacheKey, processed);
  memoryCache.set(idbKey, processed);

  // Cache in IndexedDB (non-blocking)
  setIdbCachedLyrics(idbKey, processed).catch(() => {});

  try {
    localStorage.setItem(`${STORAGE_CACHE_PREFIX}${cacheKey}`, JSON.stringify(processed));
  } catch (err) {
    // If quota exceeded, clean up old lyric cache entries
    pruneOldCache();
  }

  return processed;
}

/**
 * Prune old lyric cache items if storage is full
 */
function pruneOldCache() {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(STORAGE_CACHE_PREFIX));
    for (let i = 0; i < Math.min(keys.length, 20); i++) {
      localStorage.removeItem(keys[i]);
    }
  } catch {
    // Ignore prune errors
  }
}

/**
 * Find index of active line for current playback position
 */
export function findActiveLineIndex(syncedLines, positionMs) {
  if (!syncedLines || syncedLines.length === 0) return -1;
  if (positionMs < syncedLines[0].timeMs) return -1; // Before first line

  // Binary search or linear scan for current line
  let activeIndex = 0;
  for (let i = 0; i < syncedLines.length; i++) {
    if (syncedLines[i].timeMs <= positionMs) {
      activeIndex = i;
    } else {
      break;
    }
  }
  return activeIndex;
}

/**
 * Manual Offset Management (-5000ms to +5000ms)
 * Supports global default and per-source offset retention (e.g. mic, lastfm, search, spotify).
 */
export function getStoredOffsetMs(source = null) {
  if (typeof localStorage === 'undefined') return 0;
  
  if (source) {
    const sourceKey = `${STORAGE_OFFSET_KEY}_${source.toLowerCase()}`;
    const sourceVal = localStorage.getItem(sourceKey);
    if (sourceVal !== null) {
      const num = parseInt(sourceVal, 10);
      return isNaN(num) ? 0 : Math.max(-5000, Math.min(5000, num));
    }
  }

  const val = localStorage.getItem(STORAGE_OFFSET_KEY);
  if (!val) return 0;
  const num = parseInt(val, 10);
  return isNaN(num) ? 0 : Math.max(-5000, Math.min(5000, num));
}

export function setStoredOffsetMs(offsetMs, source = null) {
  const clamped = Math.max(-5000, Math.min(5000, Math.round(offsetMs)));
  if (typeof localStorage !== 'undefined') {
    if (source) {
      localStorage.setItem(`${STORAGE_OFFSET_KEY}_${source.toLowerCase()}`, clamped.toString());
    }
    // Also keep global key synchronized as baseline
    localStorage.setItem(STORAGE_OFFSET_KEY, clamped.toString());
  }
  return clamped;
}
