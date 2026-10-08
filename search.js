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

  // Validate and clamp search query length (prevent oversized or malformed payloads)
  const cleanQuery = query.trim().slice(0, 100);
  if (cleanQuery.length === 0) {
    return [];
  }

  const clampedLimit = Math.max(1, Math.min(25, Number(limit) || 8));
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
    this.audio = null;
  }

  /**
   * Set and select track from search/charts results, ready for Start or auto-play.
   */
  selectTrack(track, autoStart = false) {
    if (!track) return;

    this.cleanupAudio();

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
      previewUrl: track.previewUrl || null,
      duration: this.durationSec,
      durationMs: Math.round(this.durationSec * 1000),
      position: 0,
      isPlaying: this.isPlaying,
      source: track.source || 'search'
    };

    this.onTrackChange(this.currentTrack);

    // Initialize real audio playback when in browser environment
    if (typeof Audio !== 'undefined') {
      if (track.previewUrl) {
        this.initAudio(track.previewUrl, autoStart);
      } else if (track.title && track.artist) {
        // Asynchronously discover preview URL if not yet resolved
        this.discoverPreviewUrl(track.artist, track.title).then(purl => {
          if (purl && this.currentTrack && this.currentTrack.id === this.currentTrack.id) {
            this.currentTrack.previewUrl = purl;
            this.initAudio(purl, this.isPlaying);
          }
        });
      }
    }

    if (autoStart) {
      if (!this.audio) {
        this.startClock();
      }
    }
  }

  initAudio(url, autoPlay = true) {
    if (typeof window === 'undefined' || !url) return;
    this.cleanupAudio();

    try {
      // Prioritize the dedicated DOM audio element to ensure the OS/browser routes audio to the device speaker
      const domAudio = typeof document !== 'undefined' ? document.getElementById('speakerAudioPlayer') : null;
      this.audio = domAudio || (typeof Audio !== 'undefined' ? new Audio() : null);
      if (!this.audio) return;

      this.audio.crossOrigin = 'anonymous';
      this.audio.preload = 'auto';
      this.audio.volume = 1.0;
      this.audio.muted = false;
      this.audio.src = url;

      this.audio.onplay = () => {
        this.isPlaying = true;
        this.stopClock();
        if (this.currentTrack) {
          this.currentTrack.isPlaying = true;
          this.onPlaybackUpdate(this.currentTrack);
        }
      };

      this.audio.onpause = () => {
        this.isPlaying = false;
        if (this.currentTrack) {
          this.currentTrack.isPlaying = false;
          this.onPlaybackUpdate(this.currentTrack);
        }
      };

      this.audio.ontimeupdate = () => {
        if (!this.audio || !this.currentTrack) return;
        this.positionSec = this.audio.currentTime;
        this.currentTrack.position = this.positionSec;
        this.onPlaybackUpdate(this.currentTrack);
      };

      this.audio.onloadedmetadata = () => {
        if (!this.audio || !this.currentTrack) return;
        if (this.audio.duration && isFinite(this.audio.duration)) {
          this.durationSec = this.audio.duration;
          this.currentTrack.duration = this.durationSec;
          this.currentTrack.durationMs = Math.round(this.durationSec * 1000);
          this.onPlaybackUpdate(this.currentTrack);
        }
      };

      this.audio.onended = () => {
        this.pause();
        if (this.currentTrack) {
          this.positionSec = 0;
          this.currentTrack.position = 0;
          this.onPlaybackUpdate(this.currentTrack);
        }
      };

      this.audio.onerror = (e) => {
        console.warn('Audio preview playback error, falling back to clock:', e);
        if (this.isPlaying) {
          this.startClock();
        }
      };

      if (autoPlay) {
        const p = this.audio.play();
        if (p !== undefined) {
          p.catch(err => {
            console.warn('Audio play prevented by browser policy (gesture required):', err);
            this.startClock();
          });
        }
      }
    } catch (err) {
      console.warn('Failed to initialize Audio element:', err);
      if (autoPlay) {
        this.startClock();
      }
    }
  }

  async discoverPreviewUrl(artist, title) {
    try {
      const q = `${artist} ${title}`.trim().slice(0, 100);
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`);
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results[0] && data.results[0].previewUrl) {
          return data.results[0].previewUrl;
        }
      }
    } catch {}
    return null;
  }

  cleanupAudio() {
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.onplay = null;
        this.audio.onpause = null;
        this.audio.ontimeupdate = null;
        this.audio.onloadedmetadata = null;
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch {}
      this.audio = null;
    }
  }

  /**
   * Starts or resumes playback
   */
  play() {
    if (!this.currentTrack) return;
    this.isPlaying = true;
    this.lastAnchorTime = performance.now();
    this.currentTrack.isPlaying = true;
    this.currentTrack.position = this.positionSec;

    if (this.audio) {
      const p = this.audio.play();
      if (p !== undefined) {
        p.catch(err => {
          console.warn('Play error:', err);
          this.startClock();
        });
      }
    } else {
      this.startClock();
    }

    this.onPlaybackUpdate(this.currentTrack);
  }

  /**
   * Pauses the playback clock & audio
   */
  pause() {
    if (!this.currentTrack) return;
    this.isPlaying = false;
    if (this.audio) {
      try { this.audio.pause(); } catch {}
    }
    this.stopClock();
    this.currentTrack.isPlaying = false;
    this.currentTrack.position = this.positionSec;
    this.onPlaybackUpdate(this.currentTrack);
  }

  /**
   * Seeks to a specific second
   */
  seek(targetSec) {
    if (!this.currentTrack) return;
    this.positionSec = Math.max(0, Math.min(this.durationSec, targetSec));
    this.lastAnchorTime = performance.now();
    if (this.audio && isFinite(this.positionSec)) {
      try {
        this.audio.currentTime = this.positionSec;
      } catch (err) {
        console.warn('Audio seek error:', err);
      }
    }
    this.currentTrack.position = this.positionSec;
    this.onPlaybackUpdate(this.currentTrack);
  }

  updatePosition() {
    if (!this.isPlaying) return;
    if (this.audio) {
      this.positionSec = this.audio.currentTime;
      return;
    }
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
    this.cleanupAudio();
    this.stopClock();
    this.isPlaying = false;
    this.currentTrack = null;
    this.positionSec = 0;
    this.onIdle();
  }
}
