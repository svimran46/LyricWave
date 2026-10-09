/**
 * LyricWave Phone Source (Android app only)
 *
 * Follows whatever music app is playing on the phone — Spotify, YouTube Music,
 * Apple Music, Tidal, SoundCloud... — through Android media sessions exposed by the
 * native shell (window.LyricWaveNative). Gives exact playback position, so lyrics sync
 * tightly without any account login.
 *
 * Implements the standard source contract used by UnifiedSyncEngine:
 *   start(), stop(), currentTrack, onTrackChange, onPlaybackUpdate, onIdle, onError
 */

import { normalizeNowPlaying } from './types.js';

const POLL_INTERVAL_MS = 2000;

/** Friendly names for common music apps (package -> label). */
export const MUSIC_APP_NAMES = {
  'com.spotify.music': 'Spotify',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.youtube': 'YouTube',
  'com.apple.android.music': 'Apple Music',
  'com.aspiro.tidal': 'Tidal',
  'deezer.android.app': 'Deezer',
  'com.soundcloud.android': 'SoundCloud',
  'com.amazon.mp3': 'Amazon Music',
  'com.jio.media.jiobeats': 'JioSaavn',
  'com.gaana': 'Gaana',
  'com.anghami': 'Anghami',
  'com.shazam.android': 'Shazam',
  'com.sec.android.app.music': 'Samsung Music',
  'com.miui.player': 'Mi Music',
  'com.android.chrome': 'Chrome',
  'org.mozilla.firefox': 'Firefox',
  'com.brave.browser': 'Brave'
};

// Apps whose "title" is usually a video title like "Artist - Song (Official Video)".
const VIDEO_STYLE_PACKAGES = new Set([
  'com.google.android.youtube',
  'com.android.chrome',
  'org.mozilla.firefox',
  'com.brave.browser',
  'com.microsoft.emmx',
  'com.opera.browser',
  'com.sec.android.app.sbrowser'
]);

export function appNameFor(pkg) {
  return MUSIC_APP_NAMES[pkg] || '';
}

/**
 * Turn raw media-session metadata into a clean { title, artist } for lyric lookup.
 * Handles YouTube/browser style titles ("Artist - Song (Official Video)") and channel
 * names ("ArtistVEVO", "Artist - Topic").
 */
export function cleanNowPlayingMetadata({ title = '', artist = '', package: pkg = '' } = {}) {
  let t = String(title || '').trim();
  let a = String(artist || '').trim();

  const stripNoise = (s) => s
    .replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyrics?|visuali[sz]er|music video|mv|hd|4k|hq|live|performance)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*\|\s*.*$/, '')            // "Song | Album Trailer"
    .replace(/\s+/g, ' ')
    .trim();

  const cleanChannel = (s) => s
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  const videoStyle = VIDEO_STYLE_PACKAGES.has(pkg) || !a;
  if (videoStyle) {
    const sep = t.match(/\s[-–—]\s/);
    if (sep) {
      const idx = t.indexOf(sep[0]);
      const left = t.slice(0, idx).trim();
      const right = t.slice(idx + sep[0].length).trim();
      if (left && right) {
        a = left;
        t = right;
      }
    }
  }

  t = stripNoise(t);
  a = cleanChannel(a);
  return { title: t, artist: a };
}

export class PhoneMediaSource {
  constructor(options = {}) {
    this.name = 'phone';
    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPlaybackUpdate = options.onPlaybackUpdate || (() => {});
    this.onIdle = options.onIdle || (() => {});
    this.onError = options.onError || (() => {});
    /** UI hook: (state) => void with { access, active, appName, isPlaying, title, artist }. */
    this.onStatus = options.onStatus || (() => {});

    this.bridge = options.bridge || null;
    this.pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
    this.isRunning = false;
    this.timer = null;
    this.currentKey = null;
    this.currentTrack = null;
    this.trackStartedAt = 0; // performance.now() when the current track was first seen
    this._pushHandler = (snap) => this.handleSnapshot(snap);
  }

  _getBridge() {
    if (this.bridge) return this.bridge;
    return (typeof window !== 'undefined' && window.LyricWaveNative) ? window.LyricWaveNative : null;
  }

  /** True inside an app build whose native shell supports media sessions. */
  static isAvailable(bridge = null) {
    const b = bridge || (typeof window !== 'undefined' ? window.LyricWaveNative : null);
    return Boolean(b && typeof b.getNowPlaying === 'function' && typeof b.hasMediaAccess === 'function');
  }

  hasAccess() {
    const b = this._getBridge();
    try { return Boolean(b && b.hasMediaAccess()); } catch { return false; }
  }

  openAccessSettings() {
    const b = this._getBridge();
    try { b?.openMediaAccessSettings?.(); } catch {}
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    if (typeof window !== 'undefined') {
      window.__lyricwaveNowPlaying = this._pushHandler;
    }
    this.poll();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (typeof window !== 'undefined' && window.__lyricwaveNowPlaying === this._pushHandler) {
      window.__lyricwaveNowPlaying = null;
    }
    const hadTrack = this.currentKey !== null;
    this.currentKey = null;
    this.currentTrack = null;
    if (hadTrack) this.onIdle();
  }

  poll() {
    if (!this.isRunning) return;
    const b = this._getBridge();
    if (b && typeof b.getNowPlaying === 'function') {
      try {
        const raw = b.getNowPlaying();
        this.handleSnapshot(typeof raw === 'string' ? JSON.parse(raw) : raw);
      } catch (err) {
        console.warn('PhoneMediaSource poll error:', err);
      }
    }
    if (this.isRunning) {
      this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
    }
  }

  /** Engine transport hooks: drive the actual music app, not just the lyrics clock. */
  play() { this._control('play', -1); }
  pause() { this._control('pause', -1); }
  seek(sec) { this._control('seek', Math.max(0, Math.round(Number(sec) * 1000))); }

  _control(action, positionMs) {
    const b = this._getBridge();
    try { b?.mediaControl?.(action, positionMs); } catch {}
    // Ask for a fresh snapshot shortly after so the UI reflects the app's real state.
    if (this.isRunning) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.poll(), 400);
    }
  }

  /** Process a native snapshot (from a poll or a push). */
  handleSnapshot(snap) {
    if (!this.isRunning || !snap) return;
    const appName = appNameFor(snap.package) || '';

    if (!snap.access || !snap.active || !snap.title) {
      // Android stops the media monitor while LyricWave is in the background, so polls then report
      // "nothing playing". Keep the current song until the app is visible again.
      if (this.currentKey !== null && typeof document !== 'undefined' && document.hidden) return;
      this.onStatus({ access: Boolean(snap.access), active: false, appName, isPlaying: false });
      if (this.currentKey !== null) {
        this.currentKey = null;
        this.currentTrack = null;
        this.onIdle();
      }
      return;
    }

    const { title, artist } = cleanNowPlayingMetadata(snap);
    const key = `${snap.package}::${title}::${artist}`.toLowerCase();
    const durationMs = Number(snap.durationMs) || 0;
    const positionMs = Number(snap.positionMs);
    const knownPosition = Number.isFinite(positionMs) && positionMs >= 0;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const isNew = key !== this.currentKey;
    if (isNew) this.trackStartedAt = now;
    // Rare apps report no position: count from when we first saw the track (approximate).
    const approxSec = (now - this.trackStartedAt) / 1000;

    const track = normalizeNowPlaying({
      id: `phone_${key}`,
      title,
      artist: artist || 'Unknown Artist',
      album: snap.album || '',
      albumArt: snap.artUri || '',
      duration: durationMs > 0 ? durationMs / 1000 : 210,
      durationEstimated: !(durationMs > 0),
      position: knownPosition ? positionMs / 1000 : (isNew ? 0 : approxSec),
      isPlaying: Boolean(snap.isPlaying),
      source: 'phone',
      // No position reported (rare): behave like Last.fm "approximate" mode.
      isApproximate: !knownPosition
    });

    this.onStatus({ access: true, active: true, appName, isPlaying: track.isPlaying, title, artist });

    this.currentTrack = track;
    if (isNew) {
      this.currentKey = key;
      this.onTrackChange(track);
    }
    this.onPlaybackUpdate(track);
  }
}
