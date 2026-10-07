/**
 * LyricWave Player Tracker (Phase 2)
 * 
 * Handles Spotify currently-playing polling (every 3s),
 * smooth local position estimation using performance.now(),
 * drift correction, seek/pause/change detection, rate limiting, and edge cases.
 */

import { getValidAccessToken } from './auth.js';

const SPOTIFY_CURRENTLY_PLAYING_ENDPOINT = 'https://api.spotify.com/v1/me/player/currently-playing';
const DEFAULT_POLL_INTERVAL_MS = 3000;
const SEEK_DRIFT_THRESHOLD_MS = 1800; // Drifts larger than 1.8s are considered intentional seeks
const DRIFT_NUDGE_FACTOR = 0.25; // Smooth drift nudge factor for small jitter

export class PlayerTracker {
  constructor(options = {}) {
    this.pollInterval = options.pollInterval || DEFAULT_POLL_INTERVAL_MS;
    
    // Callbacks
    this.onTrackChange = options.onTrackChange || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onTick = options.onTick || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onError = options.onError || (() => {});

    // State
    this.isRunning = false;
    this.pollTimer = null;
    this.rafId = null;

    // Track state
    this.currentTrackId = null;
    this.currentTrack = null;
    this.isPlaying = false;
    this.durationMs = 0;
    this.playbackType = 'none'; // 'track' | 'episode' | 'ad' | 'none'

    // Clock Anchors
    this.anchorLocalTime = 0;       // performance.now() timestamp when anchored
    this.anchorProgressMs = 0;      // progress_ms value at anchorLocalTime
    this.rawProgressMs = 0;         // Last progress_ms received directly from Spotify
    this.rawSpotifyTimestamp = 0;   // Timestamp from Spotify's payload
    this.lastLatencyMs = 0;         // Estimated one-way network latency
    this.driftMs = 0;               // Difference between estimated and reported progress
    
    // Debug & Health metrics
    this.pollCount = 0;
    this.lastPollStatus = 'Idle';
    this.lastPollTimestamp = null;
    this.isRateLimited = false;
    this.rateLimitResetTime = 0;
  }

  /**
   * Start polling and high-precision animation clock
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.pollNow();
    this.startAnimationClock();
  }

  /**
   * Stop all timers and RAF
   */
  stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resetState();
  }

  resetState() {
    this.currentTrackId = null;
    this.currentTrack = null;
    this.isPlaying = false;
    this.durationMs = 0;
    this.playbackType = 'none';
    this.anchorLocalTime = 0;
    this.anchorProgressMs = 0;
    this.rawProgressMs = 0;
    this.driftMs = 0;
  }

  /**
   * Triggers an immediate poll and reschedules next poll
   */
  async pollNow() {
    if (!this.isRunning) return;

    // Check if we are in a rate-limit cooldown
    if (this.isRateLimited) {
      const waitRemaining = this.rateLimitResetTime - Date.now();
      if (waitRemaining > 0) {
        this.scheduleNextPoll(waitRemaining);
        return;
      }
      this.isRateLimited = false;
    }

    await this.fetchCurrentlyPlaying();

    if (this.isRunning) {
      this.scheduleNextPoll(this.pollInterval);
    }
  }

  scheduleNextPoll(delayMs) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollNow();
    }, Math.max(500, delayMs));
  }

  /**
   * Poll Spotify currently-playing endpoint
   */
  async fetchCurrentlyPlaying() {
    this.pollCount++;
    this.lastPollTimestamp = new Date();

    const token = await getValidAccessToken();
    if (!token) {
      this.lastPollStatus = 'No valid token';
      this.onError(new Error('Spotify session expired or not authenticated.'));
      return;
    }

    const startTime = performance.now();

    try {
      const response = await fetch(SPOTIFY_CURRENTLY_PLAYING_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      const roundTripMs = performance.now() - startTime;
      this.lastLatencyMs = Math.round(roundTripMs / 2);

      // 204 No Content: Nothing playing
      if (response.status === 204) {
        this.lastPollStatus = '204 No Content (Idle)';
        this.handleNothingPlaying();
        return;
      }

      // 429 Too Many Requests: Rate Limited
      if (response.status === 429) {
        const retryAfterSeconds = parseInt(response.headers.get('Retry-After') || '5', 10);
        this.isRateLimited = true;
        this.rateLimitResetTime = Date.now() + (retryAfterSeconds * 1000);
        this.lastPollStatus = `429 Rate Limited (Wait ${retryAfterSeconds}s)`;
        console.warn(`Spotify API rate limit hit. Backing off for ${retryAfterSeconds}s.`);
        return;
      }

      if (!response.ok) {
        this.lastPollStatus = `HTTP ${response.status} ${response.statusText}`;
        console.warn('Spotify currently-playing error:', response.status);
        return;
      }

      const data = await response.json();
      this.lastPollStatus = '200 OK';
      this.processPlaybackData(data, roundTripMs);

    } catch (err) {
      this.lastPollStatus = `Network Error (${err.message})`;
      console.warn('Polling network error:', err);
    }
  }

  /**
   * Parse and reconcile Spotify playback state with local clock
   */
  processPlaybackData(data, roundTripMs) {
    const isPlaying = Boolean(data.is_playing);
    const currentlyPlayingType = data.currently_playing_type || 'unknown';
    const reportedProgressMs = data.progress_ms || 0;
    const spotifyTimestamp = data.timestamp || 0;
    this.rawSpotifyTimestamp = spotifyTimestamp;
    this.rawProgressMs = reportedProgressMs;

    // Edge Case: Advertisement
    if (currentlyPlayingType === 'ad' || (!data.item && isPlaying)) {
      this.handleAdPlaying(data);
      return;
    }

    // Edge Case: Episode / Podcast
    if (currentlyPlayingType === 'episode') {
      this.handlePodcastPlaying(data, roundTripMs);
      return;
    }

    const item = data.item;
    if (!item) {
      this.handleNothingPlaying();
      return;
    }

    // Normal Music Track
    this.playbackType = 'track';
    const trackId = item.id || `${item.name}-${item.artists?.[0]?.name}`;
    const isNewTrack = trackId !== this.currentTrackId;

    const trackMeta = {
      id: trackId,
      title: item.name,
      artists: item.artists?.map(a => a.name).join(', ') || 'Unknown Artist',
      album: item.album?.name || '',
      albumArt: item.album?.images?.[0]?.url || item.album?.images?.[1]?.url || '',
      durationMs: item.duration_ms || 0,
      isLocal: item.is_local || false,
      type: 'track'
    };

    const playStateChanged = this.isPlaying !== isPlaying;
    this.isPlaying = isPlaying;
    this.durationMs = trackMeta.durationMs;

    // Estimate latency compensation: Spotify progress at arrival
    const latencyComp = Math.round(roundTripMs / 2);
    const currentAdjustedProgress = Math.min(
      this.durationMs,
      reportedProgressMs + (isPlaying ? latencyComp : 0)
    );

    const now = performance.now();

    if (isNewTrack) {
      // Immediate re-anchor on new track
      this.currentTrackId = trackId;
      this.currentTrack = trackMeta;
      this.anchorProgressMs = currentAdjustedProgress;
      this.anchorLocalTime = now;
      this.driftMs = 0;

      this.onTrackChange(this.currentTrack);
      this.onStateChange(this.getStateSnapshot());
    } else {
      // Same track: reconcile clock and detect seeks
      if (isNewTrack || playStateChanged) {
        this.anchorProgressMs = currentAdjustedProgress;
        this.anchorLocalTime = now;
        this.driftMs = 0;
        this.onStateChange(this.getStateSnapshot());
      } else if (isPlaying) {
        // Calculate local predicted progress
        const localPredictedMs = this.anchorProgressMs + (now - this.anchorLocalTime);
        const drift = currentAdjustedProgress - localPredictedMs;
        this.driftMs = Math.round(drift);

        if (Math.abs(drift) > SEEK_DRIFT_THRESHOLD_MS) {
          // Intentional Seek detected: snap immediately
          this.anchorProgressMs = currentAdjustedProgress;
          this.anchorLocalTime = now;
        } else {
          // Small drift/jitter: gently nudge anchor without jumping
          this.anchorProgressMs += (drift * DRIFT_NUDGE_FACTOR);
        }
      } else {
        // Paused: anchor directly to reported progress
        this.anchorProgressMs = reportedProgressMs;
        this.anchorLocalTime = now;
        this.driftMs = 0;
      }
    }
  }

  /**
   * Handle Podcast / Episode
   */
  handlePodcastPlaying(data, roundTripMs) {
    this.playbackType = 'episode';
    const item = data.item;
    const isPlaying = Boolean(data.is_playing);
    const reportedProgressMs = data.progress_ms || 0;

    const trackId = item?.id || 'podcast-episode';
    const isNewEpisode = trackId !== this.currentTrackId;

    const podcastMeta = {
      id: trackId,
      title: item?.name || 'Podcast Episode',
      artists: item?.show?.name || 'Podcast',
      album: item?.show?.publisher || 'Spotify Podcast',
      albumArt: item?.images?.[0]?.url || item?.show?.images?.[0]?.url || '',
      durationMs: item?.duration_ms || 0,
      isLocal: false,
      type: 'episode'
    };

    this.isPlaying = isPlaying;
    this.durationMs = podcastMeta.durationMs;

    const latencyComp = Math.round(roundTripMs / 2);
    const currentAdjustedProgress = Math.min(
      this.durationMs,
      reportedProgressMs + (isPlaying ? latencyComp : 0)
    );

    const now = performance.now();

    if (isNewEpisode) {
      this.currentTrackId = trackId;
      this.currentTrack = podcastMeta;
      this.anchorProgressMs = currentAdjustedProgress;
      this.anchorLocalTime = now;
      this.onTrackChange(this.currentTrack);
      this.onStateChange(this.getStateSnapshot());
    } else {
      if (isPlaying) {
        const localPredicted = this.anchorProgressMs + (now - this.anchorLocalTime);
        const drift = currentAdjustedProgress - localPredicted;
        this.driftMs = Math.round(drift);
        if (Math.abs(drift) > SEEK_DRIFT_THRESHOLD_MS) {
          this.anchorProgressMs = currentAdjustedProgress;
          this.anchorLocalTime = now;
        } else {
          this.anchorProgressMs += (drift * DRIFT_NUDGE_FACTOR);
        }
      } else {
        this.anchorProgressMs = reportedProgressMs;
        this.anchorLocalTime = now;
      }
    }
  }

  /**
   * Handle Advertisement
   */
  handleAdPlaying(data) {
    this.playbackType = 'ad';
    this.isPlaying = Boolean(data.is_playing);
    this.currentTrackId = 'spotify-ad';
    this.currentTrack = {
      id: 'spotify-ad',
      title: 'Advertisement',
      artists: 'Spotify',
      album: 'Commercial Break',
      albumArt: '',
      durationMs: data.item?.duration_ms || 30000,
      type: 'ad'
    };
    this.durationMs = this.currentTrack.durationMs;
    this.anchorProgressMs = data.progress_ms || 0;
    this.anchorLocalTime = performance.now();

    this.onTrackChange(this.currentTrack);
    this.onStateChange(this.getStateSnapshot());
  }

  /**
   * Handle Nothing Playing (Idle / 204)
   */
  handleNothingPlaying() {
    const wasPlaying = this.currentTrack !== null;
    this.resetState();

    if (wasPlaying) {
      this.onIdle();
      this.onStateChange(this.getStateSnapshot());
    }
  }

  /**
   * Continuous high-precision local clock loop (60fps)
   */
  startAnimationClock() {
    const loop = () => {
      if (!this.isRunning) return;

      const estimatedMs = this.getEstimatedPositionMs();
      
      this.onTick({
        estimatedMs,
        rawMs: this.rawProgressMs,
        durationMs: this.durationMs,
        progressPercent: this.durationMs > 0 ? Math.min(100, (estimatedMs / this.durationMs) * 100) : 0,
        isPlaying: this.isPlaying,
        playbackType: this.playbackType,
        driftMs: this.driftMs,
        latencyMs: this.lastLatencyMs
      });

      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * Calculates the exact estimated position in milliseconds right now
   */
  getEstimatedPositionMs() {
    if (!this.currentTrack) return 0;
    if (!this.isPlaying) return Math.min(this.durationMs, this.anchorProgressMs);

    const elapsedSinceAnchor = performance.now() - this.anchorLocalTime;
    const estimated = this.anchorProgressMs + elapsedSinceAnchor;
    return Math.max(0, Math.min(this.durationMs, Math.round(estimated)));
  }

  /**
   * Returns snapshot of current state
   */
  getStateSnapshot() {
    return {
      track: this.currentTrack,
      isPlaying: this.isPlaying,
      durationMs: this.durationMs,
      estimatedProgressMs: this.getEstimatedPositionMs(),
      rawProgressMs: this.rawProgressMs,
      spotifyTimestamp: this.rawSpotifyTimestamp,
      playbackType: this.playbackType,
      driftMs: this.driftMs,
      lastLatencyMs: this.lastLatencyMs,
      pollCount: this.pollCount,
      lastPollStatus: this.lastPollStatus,
      lastPollTimestamp: this.lastPollTimestamp,
      isRateLimited: this.isRateLimited
    };
  }
}
