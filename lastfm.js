/**
 * LyricWave Last.fm Live Scrobble Tracker
 * 
 * Tracks the user's currently playing track across Apple Music,
 * YouTube Music, Tidal, Deezer, foobar2000, and any scrobbler-enabled player.
 */

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const DEFAULT_LASTFM_KEY = '4a9f5581a9cdf20a699f540f52a51c9c'; // Public client key fallback

export class LastFmSource {
  constructor(options = {}) {
    this.name = 'lastfm';
    this.username = options.username || '';
    this.apiKey = options.apiKey || DEFAULT_LASTFM_KEY;
    this.pollInterval = options.pollInterval || 4000;

    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPlaybackUpdate = options.onPlaybackUpdate || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onError = options.onError || (() => {});

    this.timer = null;
    this.isRunning = false;
    this.currentTrackKey = null;
    this.currentTrack = null;
    this.trackStartTime = 0;
  }

  setUsername(username) {
    this.username = (username || '').trim();
    if (this.username) {
      try {
        localStorage.setItem('lyricwave_lastfm_user', this.username);
      } catch (e) {}
    }
  }

  getUsername() {
    try {
      return this.username || localStorage.getItem('lyricwave_lastfm_user') || '';
    } catch (e) {
      return this.username || '';
    }
  }

  start() {
    if (this.isRunning) return;
    this.username = this.getUsername();
    if (!this.username) {
      this.onError('Please enter a Last.fm username to start tracking.');
      return;
    }
    this.isRunning = true;
    this.poll();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.currentTrackKey = null;
    this.currentTrack = null;
  }

  async poll() {
    if (!this.isRunning) return;

    try {
      const track = await this.fetchRecentTrack();
      if (!this.isRunning) return;

      if (track && track.isNowPlaying) {
        const key = `${track.title}__${track.artist}`.toLowerCase();
        const now = performance.now();

        if (key !== this.currentTrackKey) {
          // New track scrobble detected!
          // In Approximate Mode, treat the moment the track changes as position 0
          this.currentTrackKey = key;
          this.trackStartTime = now;

          const durationSec = track.durationSec > 0 ? track.durationSec : 210; // 3.5m fallback

          this.currentTrack = {
            id: `lastfm_${Date.now()}`,
            title: track.title,
            artist: track.artist,
            album: track.album || '',
            albumArt: track.albumArt || '',
            duration: durationSec,
            position: 0,
            isPlaying: true,
            source: 'lastfm',
            isApproximate: true
          };

          this.onTrackChange({ ...this.currentTrack });
        } else if (this.currentTrack) {
          // Same track still scrobbling now-playing: emit position update
          const elapsedSec = (now - this.trackStartTime) / 1000;
          this.currentTrack.position = Math.min(this.currentTrack.duration, elapsedSec);
          this.onPlaybackUpdate({ ...this.currentTrack });
        }
      } else {
        if (this.currentTrackKey !== null) {
          this.currentTrackKey = null;
          this.currentTrack = null;
          this.onIdle();
        }
      }
    } catch (err) {
      this.onError(err.message);
    }

    if (this.isRunning) {
      this.timer = setTimeout(() => this.poll(), this.pollInterval);
    }
  }

  async fetchRecentTrack() {
    const params = new URLSearchParams({
      method: 'user.getrecenttracks',
      user: this.username,
      api_key: this.apiKey,
      format: 'json',
      limit: '2'
    });

    const res = await fetch(`${LASTFM_API_URL}?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Last.fm request failed: ${res.status}`);
    }

    const data = await res.json();
    const tracks = data?.recenttracks?.track;
    if (!tracks) return null;

    const trackList = Array.isArray(tracks) ? tracks : [tracks];
    if (trackList.length === 0) return null;

    const latest = trackList[0];
    const isNowPlaying = latest['@attr']?.nowplaying === 'true';

    // Get highest resolution image available
    let art = '';
    if (Array.isArray(latest.image)) {
      const extraLarge = latest.image.find(img => img.size === 'extralarge') || latest.image[latest.image.length - 1];
      art = extraLarge?.['#text'] || '';
    }

    return {
      title: latest.name,
      artist: latest.artist?.['#text'] || latest.artist?.name || '',
      album: latest.album?.['#text'] || '',
      albumArt: art,
      durationSec: 0,
      isNowPlaying
    };
  }
}

// Backward compatibility alias
export const LastFmTracker = LastFmSource;
