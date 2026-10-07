/**
 * LyricWave Track Search Service
 * 
 * Provides instant music search with high-resolution album artwork,
 * accurate song durations, artist names, and album metadata.
 */

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';

/**
 * Searches for tracks matching a user query across iTunes and LRCLIB.
 * Returns Array<{ id, title, artist, album, albumArt, durationMs, source }>
 */
export async function searchTracks(query, limit = 8) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const cleanQuery = query.trim();
  const results = [];
  const seenKeys = new Set();

  // 1. Primary Search: iTunes Search API (fast, high-res artwork, exact duration)
  try {
    const params = new URLSearchParams({
      term: cleanQuery,
      entity: 'song',
      limit: limit.toString()
    });

    const response = await fetch(`${ITUNES_SEARCH_URL}?${params.toString()}`);
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.results)) {
        for (const item of data.results) {
          const key = `${item.trackName}__${item.artistName}`.toLowerCase();
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            // Replace 100x100 artwork with 600x600 for sharp OLED display
            const highResArt = (item.artworkUrl100 || '').replace('100x100bb', '600x600bb');
            results.push({
              id: `itunes_${item.trackId}`,
              title: item.trackName,
              artist: item.artistName,
              album: item.collectionName || '',
              albumArt: highResArt || item.artworkUrl100 || '',
              durationMs: item.trackTimeMillis || 0,
              previewUrl: item.previewUrl || null,
              source: 'search'
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('iTunes search error:', err);
  }

  // 2. Fallback / Augment with LRCLIB search if iTunes returned few or zero results
  if (results.length < 3) {
    try {
      const lrcParams = new URLSearchParams({ q: cleanQuery });
      const lrcRes = await fetch(`${LRCLIB_SEARCH_URL}?${lrcParams.toString()}`);
      if (lrcRes.ok) {
        const lrcData = await lrcRes.json();
        if (Array.isArray(lrcData)) {
          for (const item of lrcData) {
            const key = `${item.trackName}__${item.artistName}`.toLowerCase();
            if (!seenKeys.has(key) && results.length < limit) {
              seenKeys.add(key);
              results.push({
                id: `lrclib_${item.id}`,
                title: item.trackName,
                artist: item.artistName,
                album: item.albumName || '',
                albumArt: '',
                durationMs: (item.duration || 0) * 1000,
                previewUrl: null,
                source: 'search'
              });
            }
          }
        }
      }
    } catch (lrcErr) {
      console.warn('LRCLIB search error:', lrcErr);
    }
  }

  return results;
}

/**
  * SearchSource class implementing the unified NowPlaying source contract.
  * Allows the user to pick an LRCLIB/iTunes search result and control
  * playback (Start, Pause, Resume, Seek) directly driving the UnifiedSyncEngine.
  */
export class SearchSource {
  constructor(options = {}) {
    this.name = 'search';
    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPlaybackUpdate = options.onPlaybackUpdate || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onError = options.onError || (() => {});

    this.currentTrack = null;
    this.isPlaying = false;
    this.positionSec = 0;
    this.durationSec = 0;
    this.lastAnchorTime = 0;
    this.timer = null;
  }

  /**
   * Set and select track from search results, ready for Start or auto-play.
   */
  selectTrack(track, autoStart = false) {
    if (!track) return;

    const duration = (track.durationMs ? track.durationMs / 1000 : track.duration) || 180;
    this.durationSec = duration;
    this.positionSec = 0;
    this.isPlaying = autoStart;
    this.lastAnchorTime = performance.now();

    this.currentTrack = {
      id: track.id || `search_${Date.now()}`,
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      albumArt: track.albumArt || '',
      duration: this.durationSec,
      position: 0,
      isPlaying: this.isPlaying,
      source: 'search'
    };

    this.onTrackChange(this.currentTrack);

    if (autoStart) {
      this.startClock();
    }
  }

  /**
   * Starts or resumes playback clock
   */
  play() {
    if (!this.currentTrack) return;
    this.isPlaying = true;
    this.lastAnchorTime = performance.now();
    this.currentTrack.isPlaying = true;
    this.currentTrack.position = this.positionSec;
    this.onPlaybackUpdate(this.currentTrack);
    this.startClock();
  }

  /**
   * Pauses the playback clock
   */
  pause() {
    if (!this.currentTrack) return;
    this.updatePosition();
    this.isPlaying = false;
    this.currentTrack.isPlaying = false;
    this.currentTrack.position = this.positionSec;
    this.stopClock();
    this.onPlaybackUpdate(this.currentTrack);
  }

  /**
   * Seeks to a specific second
   */
  seek(targetSec) {
    if (!this.currentTrack) return;
    this.positionSec = Math.max(0, Math.min(this.durationSec, targetSec));
    this.lastAnchorTime = performance.now();
    this.currentTrack.position = this.positionSec;
    this.onPlaybackUpdate(this.currentTrack);
  }

  updatePosition() {
    if (!this.isPlaying) return;
    const now = performance.now();
    const elapsed = (now - this.lastAnchorTime) / 1000;
    this.positionSec = Math.min(this.durationSec, this.positionSec + elapsed);
    this.lastAnchorTime = now;
  }

  startClock() {
    this.stopClock();
    this.timer = setInterval(() => {
      if (!this.isPlaying || !this.currentTrack) return;
      this.updatePosition();
      this.currentTrack.position = this.positionSec;
      this.onPlaybackUpdate(this.currentTrack);

      if (this.positionSec >= this.durationSec) {
        this.pause();
      }
    }, 1000);
  }

  stopClock() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop() {
    this.stopClock();
    this.isPlaying = false;
    this.currentTrack = null;
    this.positionSec = 0;
    this.onIdle();
  }
}
