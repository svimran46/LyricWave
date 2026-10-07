/**
 * LyricWave Unified Sync Engine
 * 
 * Source-agnostic synchronization coordinator.
 * Accepts any music source adhering to the Now Playing interface
 * (title, artist, album, duration, position in seconds, isPlaying).
 * 
 * Handles:
 * - High-precision local clock with performance.now()
 * - Re-anchoring on incoming source updates
 * - Immediate seek and pause detection
 * - Latency calibration offset (-5s to +5s)
 * - LRCLIB synced lyrics fetching & parsing
 * - Active lyric line selection
 */

import { normalizeNowPlaying } from './types.js';
import { fetchLyrics, findActiveLineIndex, getStoredOffsetMs, setStoredOffsetMs } from './lyrics.js';

const SEEK_DRIFT_THRESHOLD_SEC = 1.8; // Drifts larger than 1.8s trigger an instant anchor snap
const DRIFT_NUDGE_FACTOR = 0.25;       // Nudge factor for micro-jitter

export class UnifiedSyncEngine {
  constructor(options = {}) {
    // Callbacks
    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPlaybackChange = options.onPlaybackChange || (() => {});
    this.onLyricsLoaded = options.onLyricsLoaded || (() => {});
    this.onLineChange = options.onLineChange || (() => {});
    this.onTick = options.onTick || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onSongEnd = options.onSongEnd || (() => {});
    this.onError = options.onError || (() => {});

    // Active track & playback state (Normalized NowPlaying)
    this.track = null;
    this.isPlaying = false;
    this.durationSec = 0;
    this.durationMs = 0;
    this.rawPositionSec = 0;

    // Local Clock Anchor
    this.anchorLocalTime = 0;  // performance.now() timestamp
    this.anchorPositionSec = 0; // progress in seconds at anchorLocalTime
    this.driftSec = 0;
    this.rafId = null;

    // Latency calibration & lyrics state
    this.offsetMs = getStoredOffsetMs();
    this.lyricsData = null;
    this.activeLineIndex = -1;

    // Current source connection
    this.currentSource = null;

    // Resync clock when returning to foreground tab
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.isPlaying && this.track) {
          this.anchorPositionSec = this.getPositionSeconds();
          this.anchorLocalTime = performance.now();
          if (!this.rafId) this.start();
        }
      });
    }
  }

  /**
   * Connect an external music source (e.g., SpotifySource)
   */
  connectSource(source) {
    if (this.currentSource && typeof this.currentSource.stop === 'function') {
      this.currentSource.stop();
    }

    this.currentSource = source;

    if (!source) return;

    source.onTrackChange = (track) => this.setTrack(track);
    source.onPlaybackUpdate = (track) => this.updatePlayback(track);
    source.onIdle = () => this.handleIdle();
    const originalSourceOnError = source.onError;
    source.onError = (err) => {
      if (typeof originalSourceOnError === 'function') {
        try { originalSourceOnError(err); } catch {}
      }
      this.onError(err);
    };

    // If source already has an active track, sync immediately
    if (source.currentTrack) {
      this.setTrack(source.currentTrack, source.currentTrack.isPlaying);
    }

    if (typeof source.start === 'function') {
      source.start();
    }
  }

  start() {
    if (!this.rafId && typeof requestAnimationFrame === 'function') {
      this.loop = this.loop.bind(this);
      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  stop() {
    if (this.rafId) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.rafId);
      }
      this.rafId = null;
    }
    if (this.currentSource && typeof this.currentSource.stop === 'function') {
      this.currentSource.stop();
    }
  }

  /**
   * Set or change active track (Accepts any object conforming to NowPlaying interface)
   */
  async setTrack(trackData, autoPlay = true, forceReload = false) {
    if (!trackData) return;

    const normalized = normalizeNowPlaying(trackData);
    const isNew = forceReload || !this.track || this.track.id !== normalized.id;

    this.track = normalized;
    this.durationSec = normalized.duration || 180;
    this.durationMs = Math.round(this.durationSec * 1000);
    this.rawPositionSec = normalized.position || 0;
    this.isPlaying = typeof normalized.isPlaying === 'boolean' ? normalized.isPlaying : autoPlay;

    // Anchor clock
    const now = performance.now();
    this.anchorPositionSec = this.rawPositionSec;
    this.anchorLocalTime = now;
    this.driftSec = 0;
    this.activeLineIndex = -1;

    // Ensure the animation & sync loop is running
    this.start();

    if (isNew) {
      if (normalized.source) {
        this.loadOffsetForSource(normalized.source);
      }
      this.lyricsData = null;
      this.onTrackChange(this.track);
      this.onPlaybackChange(this.isPlaying);

      // Fetch synced lyrics via LRCLIB
      try {
        this.lyricsData = { status: 'loading' };
        this.onLyricsLoaded(this.lyricsData);

        // Convert duration to ms for lyrics.js helper
        const lyrics = await fetchLyrics({
          id: this.track.id,
          title: this.track.title,
          artists: this.track.artist,
          album: this.track.album,
          durationMs: this.durationSec * 1000
        });

        if (this.track && this.track.id === normalized.id) {
          this.lyricsData = lyrics;
          this.onLyricsLoaded(this.lyricsData);
        }
      } catch (err) {
        this.lyricsData = { status: 'error', message: 'Unable to load lyrics.' };
        this.onLyricsLoaded(this.lyricsData);
      }
    } else {
      this.onPlaybackChange(this.isPlaying);
    }
  }

  /**
   * Receive continuous playback updates from source
   */
  updatePlayback(trackData) {
    if (!trackData) return;
    const normalized = normalizeNowPlaying(trackData);

    if (!this.track || this.track.id !== normalized.id) {
      this.setTrack(normalized, normalized.isPlaying);
      return;
    }

    const wasPlaying = this.isPlaying;
    const isPlaying = normalized.isPlaying;
    this.isPlaying = isPlaying;
    this.durationSec = normalized.duration || this.durationSec;
    this.durationMs = Math.round(this.durationSec * 1000);
    this.rawPositionSec = normalized.position;

    const now = performance.now();

    if (wasPlaying !== isPlaying) {
      // Pause/Resume state changed: re-anchor immediately
      this.anchorPositionSec = this.rawPositionSec;
      this.anchorLocalTime = now;
      this.driftSec = 0;
      this.onPlaybackChange(isPlaying);
    } else if (isPlaying) {
      // Re-anchor clock with drift checking
      const localPredictedSec = this.anchorPositionSec + ((now - this.anchorLocalTime) / 1000);
      const drift = this.rawPositionSec - localPredictedSec;
      this.driftSec = drift;

      if (Math.abs(drift) > SEEK_DRIFT_THRESHOLD_SEC) {
        // Intentional seek: snap clock instantly
        this.anchorPositionSec = this.rawPositionSec;
        this.anchorLocalTime = now;
      } else {
        // Gentle micro-nudge
        this.anchorPositionSec += (drift * DRIFT_NUDGE_FACTOR);
      }
    } else {
      // Paused: hold position firmly
      this.anchorPositionSec = this.rawPositionSec;
      this.anchorLocalTime = now;
      this.driftSec = 0;
    }
  }

  handleIdle() {
    this.track = null;
    this.isPlaying = false;
    this.durationSec = 0;
    this.durationMs = 0;
    this.anchorPositionSec = 0;
    this.rawPositionSec = 0;
    this.lyricsData = null;
    this.activeLineIndex = -1;
    this.onIdle();
  }

  play() {
    if (!this.track || this.isPlaying) return;
    this.isPlaying = true;
    this.anchorLocalTime = performance.now();
    this.start();
    if (this.currentSource && typeof this.currentSource.play === 'function') {
      try { this.currentSource.play(); } catch {}
    }
    this.onPlaybackChange(true);
  }

  pause() {
    if (!this.track || !this.isPlaying) return;
    this.anchorPositionSec = this.getPositionSeconds();
    this.anchorLocalTime = performance.now();
    this.isPlaying = false;
    if (this.currentSource && typeof this.currentSource.pause === 'function') {
      try { this.currentSource.pause(); } catch {}
    }
    this.onPlaybackChange(false);
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  seek(target) {
    if (!this.track) return;
    const targetNum = Number(target);
    if (isNaN(targetNum)) return;
    // Handle either seconds or milliseconds (if > 1000 and durationSec < 1000, treat as ms)
    const targetSec = (targetNum > this.durationSec && targetNum > 1000) ? (targetNum / 1000) : targetNum;
    const clampedSec = Math.max(0, Math.min(this.durationSec, targetSec));
    this.anchorPositionSec = clampedSec;
    this.anchorLocalTime = performance.now();
    this.activeLineIndex = -1;
    if (this.currentSource && typeof this.currentSource.seek === 'function') {
      try { this.currentSource.seek(clampedSec); } catch {}
    }
  }

  seekBy(delta) {
    const deltaNum = Number(delta);
    if (isNaN(deltaNum)) return;
    // If delta is large (> 50 or < -50), treat as ms
    const deltaSec = (Math.abs(deltaNum) > 50) ? (deltaNum / 1000) : deltaNum;
    this.seek(this.getPositionSeconds() + deltaSec);
  }

  setOffset(newOffsetMs, source = null) {
    const src = source || this.track?.source || this.currentSource?.name || null;
    this.offsetMs = setStoredOffsetMs(newOffsetMs, src);
  }

  loadOffsetForSource(source) {
    if (!source) return;
    this.offsetMs = getStoredOffsetMs(source);
  }

  getOffset() {
    return this.offsetMs;
  }

  /**
   * Get estimated position in seconds using local clock
   */
  getPositionSeconds() {
    if (!this.track) return 0;
    if (!this.isPlaying) return Math.min(this.durationSec, this.anchorPositionSec);

    const elapsedSec = (performance.now() - this.anchorLocalTime) / 1000;
    const current = this.anchorPositionSec + elapsedSec;
    return Math.max(0, Math.min(this.durationSec, current));
  }

  getPositionMs() {
    return Math.round(this.getPositionSeconds() * 1000);
  }

  getEffectivePositionMs() {
    return this.getPositionMs() + this.offsetMs;
  }

  loop() {
    if (this.track && (typeof document === 'undefined' || !document.hidden)) {
      const positionSec = this.getPositionSeconds();
      const positionMs = Math.round(positionSec * 1000);
      const effectiveMs = positionMs + this.offsetMs;
      const durationMs = Math.round(this.durationSec * 1000);
      const progressPercent = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

      // Handle song finish
      if (this.isPlaying && positionSec >= this.durationSec && this.durationSec > 0) {
        this.pause();
        this.seek(0);
        this.onSongEnd(this.track);
      }

      // Check active lyric line
      if (this.lyricsData && this.lyricsData.status === 'synced' && this.lyricsData.syncedLines.length > 0) {
        const nextActiveIdx = findActiveLineIndex(this.lyricsData.syncedLines, effectiveMs);
        if (nextActiveIdx !== this.activeLineIndex) {
          this.activeLineIndex = nextActiveIdx;
          this.onLineChange(this.activeLineIndex, this.lyricsData.syncedLines[this.activeLineIndex] || null);
        }
      }

      // Tick notification
      this.onTick({
        positionSec,
        positionMs,
        rawMs: Math.round(this.rawPositionSec * 1000),
        effectiveMs,
        durationMs,
        durationSec: this.durationSec,
        progressPercent,
        isPlaying: this.isPlaying,
        driftMs: Math.round(this.driftSec * 1000),
        activeLineIndex: this.activeLineIndex
      });
    }

    if (this.rafId !== null) {
      this.rafId = requestAnimationFrame(this.loop);
    }
  }
}
