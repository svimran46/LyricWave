/**
 * LyricWave Application Controller
 * 
 * Master controller unifying 4 music input sources:
 * 1. Microphone Recognition (Default hero view)
 * 2. Manual Search (Instant lookup across iTunes & LRCLIB)
 * 3. Last.fm (Live scrobbles from Apple Music, YouTube Music, Tidal, etc.)
 * 4. Spotify Live Tracking (Private Beta)
 * 
 * All sources feed one shared UnifiedSyncEngine, driving the
 * OLED Lyrics Reel Visualizer and Synced Lyrics View.
 */

import { CONFIG } from './config.js';
import {
  initiateLogin,
  handleRedirectCallback,
  fetchUserProfile,
  getStoredUserProfile,
  isAuthenticated,
  logout
} from './auth.js';
import { SpotifySource } from './spotify-source.js';
import { MicSource } from './mic.js';
import { searchTracks, SearchSource } from './search.js';
import { LastFmSource } from './lastfm.js';
import { UnifiedSyncEngine } from './engine.js';
import { ReelVisualizer } from './reel.js';
import { signUp, logIn, logOut, getCurrentUser, updateUserPreferences, deleteCurrentAccount } from './user-auth.js';

// DOM Elements: Navigation Tabs
const sourceNav = document.getElementById('sourceNav');
const sourceTabs = document.querySelectorAll('.source-tab');
const tabPanels = {
  mic: document.getElementById('panelMic'),
  search: document.getElementById('panelSearch'),
  charts: document.getElementById('panelCharts'),
  news: document.getElementById('panelNews'),
  connect: document.getElementById('panelConnect'),
  lastfm: document.getElementById('panelLastfm'),
  spotify: document.getElementById('panelSpotify')
};

// DOM Elements: Connect Segmented Switcher
const panelConnect = document.getElementById('panelConnect');
const btnSubLastfm = document.getElementById('btnSubLastfm');
const btnSubSpotify = document.getElementById('btnSubSpotify');
const btnSubApple = document.getElementById('btnSubApple');
const subPanels = {
  lastfm: document.getElementById('panelLastfm'),
  spotify: document.getElementById('panelSpotify'),
  apple: document.getElementById('panelApple')
};

// DOM Elements: Now Playing Compact Bar & Recent Songs
const compactSourceBar = document.getElementById('compactSourceBar');
const btnListenAgain = document.getElementById('btnListenAgain');
const btnSwitchSourceCompact = document.getElementById('btnSwitchSourceCompact');
const compactSourceLabel = document.getElementById('compactSourceLabel');
const recentSongsList = document.getElementById('recentSongsList');
const btnClearRecent = document.getElementById('btnClearRecent');

// DOM Elements: On-Stage Live Sync Nudge
const btnNudgeMinus = document.getElementById('btnNudgeMinus');
const btnNudgePlus = document.getElementById('btnNudgePlus');
const btnNudgeReset = document.getElementById('btnNudgeReset');
const onStageOffsetLabel = document.getElementById('onStageOffsetLabel');

// DOM Elements: Keyboard Shortcuts Cheat-sheet Modal
const btnOpenShortcuts = document.getElementById('btnOpenShortcuts');
const shortcutsBackdrop = document.getElementById('shortcutsBackdrop');
const btnCloseShortcuts = document.getElementById('btnCloseShortcuts');
const btnDoneShortcuts = document.getElementById('btnDoneShortcuts');

// DOM Elements: Mobile Bottom Sheet Drag Handle
const settingsDragHandle = document.getElementById('settingsDragHandle');
const settingsDialog = document.getElementById('settingsDialog');

// DOM Elements: Alerts & Header
const alertContainer = document.getElementById('alertContainer');
const offlineBanner = document.getElementById('offlineBanner');
const offlineBannerText = document.getElementById('offlineBannerText');
const btnInstallPwa = document.getElementById('btnInstallPwa');
const btnOpenSettings = document.getElementById('btnOpenSettings');

// DOM Elements: Developer Mode
const devModeBanner = document.getElementById('devModeBanner');
const devClientIdStatus = document.getElementById('devClientIdStatus');
const devRedirectStatus = document.getElementById('devRedirectStatus');
const devDbgRawMs = document.getElementById('devDbgRawMs');
const devDbgEstimatedMs = document.getElementById('devDbgEstimatedMs');
const devDbgDriftMs = document.getElementById('devDbgDriftMs');
const devDbgLatencyMs = document.getElementById('devDbgLatencyMs');
const devDbgPollStatus = document.getElementById('devDbgPollStatus');
const devDbgPlayState = document.getElementById('devDbgPlayState');

// DOM Elements: Microphone Input
const btnMicListen = document.getElementById('btnMicListen');
const micRingPulse = document.getElementById('micRingPulse');
const micStatusTitle = document.getElementById('micStatusTitle');
const micStatusSubtitle = document.getElementById('micStatusSubtitle');
const micCountdownWrap = document.getElementById('micCountdownWrap');
const micCountdownText = document.getElementById('micCountdownText');
const micCountdownCircle = document.getElementById('micCountdownCircle');
const micLevelMeterWrap = document.getElementById('micLevelMeterWrap');
const micLevelFill = document.getElementById('micLevelFill');
const micActionRow = document.getElementById('micActionRow');
const btnMicCancel = document.getElementById('btnMicCancel');
const btnShowMicConsent = document.getElementById('btnShowMicConsent');
const micConsentBackdrop = document.getElementById('micConsentBackdrop');
const btnCloseMicConsent = document.getElementById('btnCloseMicConsent');
const btnCancelMicConsent = document.getElementById('btnCancelMicConsent');
const btnAcceptMicConsent = document.getElementById('btnAcceptMicConsent');

// DOM Elements: Search Input
const searchInput = document.getElementById('searchInput');
const btnClearSearch = document.getElementById('btnClearSearch');
const searchResults = document.getElementById('searchResults');

// DOM Elements: Charts Panel
const panelCharts = document.getElementById('panelCharts');
const chartsListContainer = document.getElementById('chartsListContainer');
const btnRefreshCharts = document.getElementById('btnRefreshCharts');
const chartsUpdatedTag = document.getElementById('chartsUpdatedTag');
const genrePills = document.querySelectorAll('.genre-pill');

// DOM Elements: News Panel
const panelNews = document.getElementById('panelNews');
const newsListContainer = document.getElementById('newsListContainer');
const btnRefreshNews = document.getElementById('btnRefreshNews');
const newsUpdatedTag = document.getElementById('newsUpdatedTag');
const newsFilterPills = document.querySelectorAll('.news-filter-pill');

// DOM Elements: Last.fm Input
const lastfmUserInput = document.getElementById('lastfmUserInput');
const btnConnectLastfm = document.getElementById('btnConnectLastfm');
const lastfmStatusInfo = document.getElementById('lastfmStatusInfo');
const lastfmStatusMsg = document.getElementById('lastfmStatusMsg');
const btnDisconnectLastfm = document.getElementById('btnDisconnectLastfm');

// DOM Elements: Spotify Beta
const spotifyLoggedOut = document.getElementById('spotifyLoggedOut');
const spotifyLoggedIn = document.getElementById('spotifyLoggedIn');
const btnLoginSpotify = document.getElementById('btnLoginSpotify');
const btnLogoutSpotify = document.getElementById('btnLogoutSpotify');
const userName = document.getElementById('userName');
const userAvatar = document.getElementById('userAvatar');
const avatarFallback = document.getElementById('avatarFallback');

// DOM Elements: Shared Active Playback View
const activePlaybackView = document.getElementById('activePlaybackView');
const trackArt = document.getElementById('trackArt');
const artPlaceholder = document.getElementById('artPlaceholder');
const playStateDot = document.getElementById('playStateDot');
const playStateText = document.getElementById('playStateText');
const trackSourceBadge = document.getElementById('trackSourceBadge');
const trackTitle = document.getElementById('trackTitle');
const trackArtist = document.getElementById('trackArtist');
const trackAlbum = document.getElementById('trackAlbum');
const btnPlayPause = document.getElementById('btnPlayPause');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const btnSeekBack = document.getElementById('btnSeekBack');
const btnSeekForward = document.getElementById('btnSeekForward');
const btnResync = document.getElementById('btnResync');
const btnShareSong = document.getElementById('btnShareSong');
const firstRunHint = document.getElementById('firstRunHint');
const btnDismissFirstRun = document.getElementById('btnDismissFirstRun');
const progressTrack = document.getElementById('progressTrack');
const progressBarFill = document.getElementById('progressBarFill');
const timeElapsed = document.getElementById('timeElapsed');
const timeDuration = document.getElementById('timeDuration');

// DOM Elements: Reel Visualizer
const reelContainer = document.getElementById('reelContainer');
const reelCanvas = document.getElementById('reelCanvas');
const reelLineBox = document.getElementById('reelLineBox');
const reelLineText = document.getElementById('reelLineText');
const reelPrevLine = document.getElementById('reelPrevLine');
const reelNextLine = document.getElementById('reelNextLine');
const btnToggleWordMode = document.getElementById('btnToggleWordMode');
const btnFullscreen = document.getElementById('btnFullscreen');
const fsLabel = document.getElementById('fsLabel');
const themePills = document.querySelectorAll('.btn-theme-pill');
const stageArtBackdrop = document.getElementById('stageArtBackdrop');

// DOM Elements: Synced Lyrics View
const lyricsStatusBadge = document.getElementById('lyricsStatusBadge');
const lyricsStatusText = document.getElementById('lyricsStatusText');
const lyricsContent = document.getElementById('lyricsContent');
const btnToggleOffset = document.getElementById('btnToggleOffset');
const offsetPreviewLabel = document.getElementById('offsetPreviewLabel');
const offsetDrawer = document.getElementById('offsetDrawer');
const offsetSlider = document.getElementById('offsetSlider');
const btnOffsetMinus = document.getElementById('btnOffsetMinus');
const btnOffsetPlus = document.getElementById('btnOffsetPlus');
const btnOffsetReset = document.getElementById('btnOffsetReset');
const offsetValueText = document.getElementById('offsetValueText');
const btnToggleAutoRelisten = document.getElementById('btnToggleAutoRelisten');
const autoRelistenDot = document.getElementById('autoRelistenDot');
const autoRelistenLabel = document.getElementById('autoRelistenLabel');
const tapLineBanner = document.getElementById('tapLineBanner');
const btnDismissTapBanner = document.getElementById('btnDismissTapBanner');

// DOM Elements: Preferences Modal
const settingsBackdrop = document.getElementById('settingsBackdrop');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnDoneSettings = document.getElementById('btnDoneSettings');
const settingThemeSelect = document.getElementById('settingThemeSelect');
const themeCards = document.querySelectorAll('.theme-swatch-card');
const settingFontSize = document.getElementById('settingFontSize');
const lblFontSize = document.getElementById('lblFontSize');
const settingWordMode = document.getElementById('settingWordMode');
const settingOffsetSlider = document.getElementById('settingOffsetSlider');
const settingRecognitionProvider = document.getElementById('settingRecognitionProvider');
const btnSettingsOffsetMinus = document.getElementById('btnSettingsOffsetMinus');
const btnSettingsOffsetPlus = document.getElementById('btnSettingsOffsetPlus');
const btnSettingsOffsetReset = document.getElementById('btnSettingsOffsetReset');
const lblSettingsOffset = document.getElementById('lblSettingsOffset');
const settingDebugMode = document.getElementById('settingDebugMode');
const diagnosticsDrawer = document.getElementById('diagnosticsDrawer');
const btnResetDefaults = document.getElementById('btnResetDefaults');
const dbgPositionMs = document.getElementById('dbgPositionMs');
const dbgEffectiveMs = document.getElementById('dbgEffectiveMs');
const dbgActiveLine = document.getElementById('dbgActiveLine');
const dbgSource = document.getElementById('dbgSource');

// Configuration & Storage Keys
const STORAGE_THEME_KEY = 'lyricwave_theme';
const STORAGE_WORD_MODE_KEY = 'lyricwave_word_mode';
const STORAGE_FONT_SCALE_KEY = 'lyricwave_font_scale';
const STORAGE_LAST_SOURCE_KEY = 'lyricwave_last_source';
const STORAGE_RECENT_SONGS_KEY = 'lyricwave_recent_songs';
const STORAGE_FIRST_RUN_DISMISSED_KEY = 'lyricwave_first_run_dismissed';
const MAX_RECENT_SONGS = 10;

function getDefaultTheme() {
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'paper';
  }
  return 'aurora';
}

// Application State
let activeTab = localStorage.getItem(STORAGE_LAST_SOURCE_KEY) || 'mic';
let isOffsetDrawerOpen = false;
let currentTheme = localStorage.getItem(STORAGE_THEME_KEY) || getDefaultTheme();
let isWordMode = localStorage.getItem(STORAGE_WORD_MODE_KEY) !== 'false';
let currentFontScale = parseInt(localStorage.getItem(STORAGE_FONT_SCALE_KEY) || '100', 10);
let deferredInstallPrompt = null;
let searchDebounceTimer = null;
let searchRequestSeq = 0;
let lineElements = [];
let reelWordElements = [];
let cursorIdleTimeout = null;

/**
 * Check if Developer Mode is active (strictly when explicitly requested via ?dev=1)
 */
function isDevMode() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('dev') === '1';
}

/**
 * True when running inside the bundled Android app (WebView served from appassets).
 */
const IS_NATIVE_APP = typeof window !== 'undefined' && (
  window.location.hostname === 'appassets.androidplatform.net' ||
  /LyricWaveNativeApp/.test(navigator.userAgent || '')
);

/**
 * Keep-screen-on while lyrics play. The Screen Wake Lock API is unavailable in Android
 * WebView, so the native shell exposes a one-method bridge for it.
 */
function setNativeKeepScreenOn(on) {
  try {
    if (window.LyricWaveNative && typeof window.LyricWaveNative.setKeepScreenOn === 'function') {
      window.LyricWaveNative.setKeepScreenOn(Boolean(on));
    }
  } catch {}
}

// =====================================================================
// Recently Identified Tracks (Persistent Local Storage)
// =====================================================================

function getRecentSongs() {
  try {
    const raw = localStorage.getItem(STORAGE_RECENT_SONGS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSong(track) {
  if (!track || !track.title) return;
  const recent = getRecentSongs();
  // Filter out duplicate if same title and artist
  const normalizedTitle = (track.title || '').trim().toLowerCase();
  const normalizedArtist = (track.artist || track.artists || '').trim().toLowerCase();
  const filtered = recent.filter(item => {
    const itemTitle = (item.title || '').trim().toLowerCase();
    const itemArtist = (item.artist || item.artists || '').trim().toLowerCase();
    return !(itemTitle === normalizedTitle && itemArtist === normalizedArtist);
  });

  const entry = {
    title: track.title,
    artist: track.artist || track.artists || 'Unknown Artist',
    album: track.album || '',
    albumArt: track.albumArt || '',
    durationSec: track.durationSec || (track.durationMs ? Math.round(track.durationMs / 1000) : 0),
    durationMs: track.durationMs || (track.durationSec ? track.durationSec * 1000 : 0),
    source: track.source || 'identified',
    timestamp: Date.now()
  };

  filtered.unshift(entry);
  if (filtered.length > MAX_RECENT_SONGS) {
    filtered.length = MAX_RECENT_SONGS;
  }

  try {
    localStorage.setItem(STORAGE_RECENT_SONGS_KEY, JSON.stringify(filtered));
  } catch (err) {
    console.warn('Failed to save recent song:', err);
  }

  renderRecentSongs();
}

function renderRecentSongs() {
  if (!recentSongsList) return;
  const songs = getRecentSongs();
  if (songs.length === 0) {
    recentSongsList.innerHTML = `<p class="recent-empty-hint">Identified songs will appear here.</p>`;
    return;
  }

  recentSongsList.innerHTML = '';
  const fragment = document.createDocumentFragment();

  songs.forEach((song) => {
    const btn = document.createElement('button');
    btn.className = 'recent-song-item';
    btn.type = 'button';
    btn.setAttribute('aria-label', `Play lyrics for ${song.title} by ${song.artist}`);

    const cleanArt = sanitizeUrl(song.albumArt);
    const artHtml = cleanArt 
      ? `<img class="recent-song-art" src="${cleanArt}" alt="" onerror="this.style.display='none'">`
      : `<div class="recent-song-art" style="display:flex;align-items:center;justify-content:center;font-size:0.75rem;opacity:0.6;">🎵</div>`;

    btn.innerHTML = `
      ${artHtml}
      <div class="recent-song-text">
        <span class="recent-song-title">${escapeHtml(song.title)}</span>
        <span class="recent-song-artist">${escapeHtml(song.artist)}</span>
      </div>
    `;

    btn.addEventListener('click', () => {
      // Load track into searchSource & engine for interactive lyrics playback
      engine.connectSource(searchSource);
      searchSource.selectTrack({
        title: song.title,
        artist: song.artist,
        album: song.album,
        albumArt: song.albumArt,
        durationSec: song.durationSec,
        durationMs: song.durationMs
      }, true);
      showAlert(`Loaded lyrics for "${song.title}"`, 'info');
    });

    fragment.appendChild(btn);
  });

  recentSongsList.appendChild(fragment);
}

if (btnClearRecent) {
  btnClearRecent.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_RECENT_SONGS_KEY);
    renderRecentSongs();
    showAlert('Recently identified songs cleared.', 'info');
  });
}

// =====================================================================
// Screen Wake Lock API (Now Playing / Reel Mode)
// =====================================================================

let wakeLockSentinel = null;

async function requestWakeLock() {
  if (document.hidden || !engine.isPlaying) return;
  setNativeKeepScreenOn(true);
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
  // Only request if playing and document is visible
  if (wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    });
  } catch (err) {
    // Fail silently (low battery mode, permissions, or backgrounded)
    wakeLockSentinel = null;
  }
}

async function releaseWakeLock() {
  setNativeKeepScreenOn(false);
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {}
    wakeLockSentinel = null;
  }
}

// Re-request wake lock when returning to tab if playing
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseWakeLock();
  } else if (engine && engine.isPlaying) {
    requestWakeLock();
  }
});

// =====================================================================
// Media Session API (System & Lock Screen Controls)
// =====================================================================

function updateMediaSessionMetadata(track) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  if (!track || !track.title) {
    navigator.mediaSession.metadata = null;
    return;
  }

  try {
    const artwork = [];
    if (track.albumArt) {
      artwork.push(
        { src: track.albumArt, sizes: '96x96', type: 'image/jpeg' },
        { src: track.albumArt, sizes: '128x128', type: 'image/jpeg' },
        { src: track.albumArt, sizes: '256x256', type: 'image/jpeg' },
        { src: track.albumArt, sizes: '512x512', type: 'image/jpeg' }
      );
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || track.artists || 'Unknown Artist',
      album: track.album || '',
      artwork
    });

    // Wire Play / Pause / Seek where source supports it
    setupMediaSessionActionHandlers();
  } catch (err) {
    // Fail silently on unsupported fields
  }
}

let mediaSessionHandlersAttached = false;
function setupMediaSessionActionHandlers() {
  if (mediaSessionHandlersAttached || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  mediaSessionHandlersAttached = true;

  try {
    navigator.mediaSession.setActionHandler('play', () => {
      engine.play();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      engine.pause();
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      const skipSec = details.seekOffset || 5;
      engine.seekBy(-skipSec);
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      const skipSec = details.seekOffset || 5;
      engine.seekBy(skipSec);
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') {
        engine.seek(details.seekTime);
      }
    });
  } catch {}
}

function updateMediaSessionPlaybackState(isPlaying) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  } catch {}
}

const reel = new ReelVisualizer(reelCanvas, reelContainer, {
  theme: currentTheme,
  wordByWordMode: isWordMode
});

const engine = new UnifiedSyncEngine({
  onTrackChange: (track) => {
    activePlaybackView.classList.remove('hidden');
    trackTitle.textContent = track.title;
    trackTitle.title = track.title;
    trackArtist.textContent = track.artists || track.artist;
    trackAlbum.textContent = track.album || '';
    if (track.isApproximate || track.source === 'lastfm') {
      trackSourceBadge.textContent = 'APPROXIMATE';
      trackSourceBadge.title = 'Last.fm sync starts at 0s on track change. Use the offset control below to calibrate.';
    } else {
      trackSourceBadge.textContent = track.source?.toUpperCase() || 'LIVE';
      trackSourceBadge.title = '';
    }

    if (track.albumArt) {
      trackArt.src = track.albumArt;
      trackArt.classList.remove('hidden');
      artPlaceholder.classList.add('hidden');
      // If user is on Album Adaptive theme, extract and apply palette immediately
      if (currentTheme === 'adaptive') {
        applyAlbumAdaptivePalette(track.albumArt);
      }
    } else {
      trackArt.classList.add('hidden');
      artPlaceholder.classList.remove('hidden');
      if (currentTheme === 'adaptive') {
        applyAlbumAdaptivePalette(null);
      }
    }

    // "Now Playing" state transition:
    // Hero lyrics stage fills the view; hide the large source panels (Microphone hero, search panel, connect panel)
    Object.keys(tabPanels).forEach(key => {
      if (tabPanels[key]) {
        tabPanels[key].classList.add('hidden');
      }
    });

    // Update compact switcher label & display compact source bar
    if (compactSourceBar) {
      compactSourceBar.classList.remove('hidden');
    }
    if (compactSourceLabel) {
      const srcName = track.source ? track.source.charAt(0).toUpperCase() + track.source.slice(1) : 'Live';
      compactSourceLabel.textContent = `${srcName} Source`;
    }

    // Persist song to recently identified list
    saveRecentSong(track);

    // Update Media Session API metadata & Lock screen controls
    updateMediaSessionMetadata(track);

    // Request Screen Wake Lock if playing
    if (engine.isPlaying || track.isPlaying) {
      requestWakeLock();
    }

    requestAnimationFrame(() => reel.resizeCanvas());
  },

  onPlaybackChange: (isPlaying) => {
    if (isPlaying) {
      playStateDot.classList.remove('paused');
      playStateText.textContent = 'Playing';
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
      requestWakeLock();
    } else {
      playStateDot.classList.add('paused');
      playStateText.textContent = 'Paused';
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
      releaseWakeLock();
    }

    updateMediaSessionPlaybackState(isPlaying);
  },

  onLyricsLoaded: (lyrics) => {
    renderLyricsState(lyrics);
  },

  onLineChange: (lineIndex, line) => {
    // 1. Highlight line in scrolling view
    for (let i = 0; i < lineElements.length; i++) {
      const el = lineElements[i];
      if (i < lineIndex) {
        el.className = 'lyric-line past-line';
      } else if (i === lineIndex) {
        el.className = 'lyric-line active-line';
      } else {
        el.className = 'lyric-line upcoming-line';
      }
    }

    if (lineIndex >= 0 && lineElements[lineIndex] && lyricsViewport) {
      // Scroll only inside the lyricsViewport container so the window / page does not jump away from the animated reel
      const el = lineElements[lineIndex];
      const targetScroll = el.offsetTop - (lyricsViewport.clientHeight / 2) + (el.clientHeight / 2);
      lyricsViewport.scrollTo({
        top: Math.max(0, targetScroll),
        behavior: 'smooth'
      });
    }

    // 2. Update OLED Reel Centered Box
    updateReelLine(lineIndex);
  },

  onTick: (tick) => {
    timeElapsed.textContent = formatMs(tick.positionMs);
    timeDuration.textContent = formatMs(tick.durationMs);
    progressBarFill.style.width = `${tick.progressPercent.toFixed(2)}%`;
    progressTrack.setAttribute('aria-valuenow', Math.round(tick.progressPercent));

    // Word reveal animation in reel
    if (reelWordElements.length > 0) {
      const reelState = reel.render(tick.effectiveMs, tick.isPlaying);
      if (reelState.wordByWordMode) {
        const currentIdx = reelState.currentWordIndex;
        for (let i = 0; i < reelWordElements.length; i++) {
          const el = reelWordElements[i];
          if (i < currentIdx) {
            el.className = 'reel-word revealed';
          } else if (i === currentIdx) {
            el.className = 'reel-word current';
          } else {
            el.className = 'reel-word';
          }
        }
      } else {
        for (let i = 0; i < reelWordElements.length; i++) {
          reelWordElements[i].className = 'reel-word revealed';
        }
      }
    } else {
      reel.render(tick.effectiveMs, tick.isPlaying);
    }

    // Developer Mode Diagnostics (localhost or ?dev=1)
    if (devDbgRawMs && isDevMode()) {
      devDbgRawMs.textContent = `${tick.rawMs.toLocaleString()} ms`;
      devDbgEstimatedMs.textContent = `${tick.positionMs.toLocaleString()} ms`;
      const driftSign = tick.driftMs >= 0 ? '+' : '';
      devDbgDriftMs.textContent = `${driftSign}${tick.driftMs} ms`;
      devDbgLatencyMs.textContent = `${spotifySource?.lastLatencyMs || 0} ms`;
      devDbgPollStatus.textContent = spotifySource?.lastPollStatus || 'Active';
      devDbgPlayState.textContent = tick.isPlaying ? 'PLAYING' : 'PAUSED';
    }

    // Diagnostics readout (if enabled in settings)
    if (settingDebugMode && settingDebugMode.checked) {
      dbgPositionMs.textContent = `${tick.positionMs.toLocaleString()} ms`;
      dbgEffectiveMs.textContent = `${tick.effectiveMs.toLocaleString()} ms`;
      dbgActiveLine.textContent = tick.activeLineIndex >= 0 ? `#${tick.activeLineIndex + 1}` : 'Intro';
      dbgSource.textContent = engine.track?.source?.toUpperCase() || 'Ready';
    }
  },

  onIdle: () => {
    activePlaybackView.classList.add('hidden');
    if (compactSourceBar) compactSourceBar.classList.add('hidden');
    // Restore active source panel view
    if (tabPanels[activeTab]) {
      tabPanels[activeTab].classList.remove('hidden');
    }
    releaseWakeLock();
    updateMediaSessionMetadata(null);
  },

  onSongEnd: (finishedTrack) => {
    // If user is on the Microphone source, auto re-listen to detect the next song
    // Only for songs the mic itself identified — never switch the mic on after a search,
    // chart or recent-song playback just because the Mic tab happens to be selected.
    if (activeTab === 'mic' && finishedTrack?.source === 'mic' && !mic.isListening && !document.hidden) {
      micStatusTitle.textContent = 'Song Finished — Listening for next song...';
      showAlert(`Finished "${finishedTrack.title}". Listening for the next song...`, 'info');
      mic.start();
    }
  },

  onError: (err) => {
    const msg = typeof err === 'string' ? err : (err?.message || 'Sync error occurred.');
    console.warn('Sync engine error:', msg);
    showAlert(msg, 'warning');
  }
});

// Start the engine loop
engine.start();

// =====================================================================
// Input Source 1: Microphone Recognition
// =====================================================================

const mic = new MicSource({
  provider: localStorage.getItem('lyricwave_recognition_provider') || CONFIG.RECOGNITION_PROVIDER || 'acrcloud',
  onStatusChange: (statusText, statusType) => {


    micStatusSubtitle.textContent = statusText;
    if (statusType === 'success') {
      micStatusTitle.textContent = 'Found!';
    } else if (statusType === 'working') {
      if (statusText.toLowerCase().includes('analyz') || statusText.toLowerCase().includes('identif')) {
        micStatusTitle.textContent = 'Matching...';
      } else {
        micStatusTitle.textContent = 'Listening...';
      }
    }
  },

  onAudioLevel: (normalizedLevel) => {
    // 1. Scale microphone orb and drive dynamic outer ring ripple
    const scale = 1 + (normalizedLevel * 0.25);
    btnMicListen.style.transform = `scale(${scale})`;

    if (micRingPulse) {
      micRingPulse.style.transform = `scale(${1 + (normalizedLevel * 0.6)})`;
      micRingPulse.style.opacity = (0.2 + (normalizedLevel * 0.8)).toFixed(2);
      micRingPulse.style.borderColor = 'var(--accent)';
    }

    // 2. Drive live audio level meter width
    if (micLevelFill) {
      const pct = Math.min(100, Math.round(normalizedLevel * 100));
      micLevelFill.style.width = `${pct}%`;
    }
  },

  onCountdown: (secondsRemaining, totalSeconds = 5) => {
    if (micCountdownText) {
      micCountdownText.textContent = `Listening... ${secondsRemaining}s`;
    }
    if (micCountdownCircle) {
      const circumference = 314.16;
      // Countdown progress fraction
      const fraction = Math.max(0, Math.min(1, (totalSeconds - secondsRemaining) / totalSeconds));
      micCountdownCircle.style.strokeDashoffset = (circumference * fraction).toFixed(2);
    }
  },

  onListeningStateChange: (isListening) => {
    btnMicListen.classList.toggle('listening', isListening);
    const orbContainer = btnMicListen.closest('.mic-orb-container');
    if (orbContainer) orbContainer.classList.toggle('listening', isListening);

    micCountdownWrap.classList.toggle('hidden', !isListening);
    micLevelMeterWrap.classList.toggle('hidden', !isListening);
    micActionRow.classList.toggle('hidden', !isListening);

    if (!isListening) {
      btnMicListen.style.transform = '';
      if (micRingPulse) {
        micRingPulse.style.transform = '';
        micRingPulse.style.opacity = '';
      }
      if (micLevelFill) micLevelFill.style.width = '0%';
      if (micCountdownCircle) {
        micCountdownCircle.style.strokeDashoffset = '0';
      }
    }
  },

  // Fired by MicSource just before it hands the track to the engine via onTrackChange.
  onIdentified: (track) => {
    micStatusTitle.textContent = 'Found!';
    micStatusSubtitle.textContent = `Found: ${track.title} - ${track.artist || track.artists}`;

    // Route mic results into the sync engine. start:false — connecting must never
    // start another recording (that used to double-record every identification).
    if (engine.currentSource !== mic) {
      engine.connectSource(mic, { start: false, syncCurrent: false });
    }
    if (activePlaybackView) {
      activePlaybackView.classList.remove('hidden');
      activePlaybackView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  },

  onError: (errMsg, errorType) => {
    btnMicListen.classList.remove('listening');
    btnMicListen.style.transform = '';
    micStatusTitle.textContent = 'Tap to Listen';
    micStatusSubtitle.textContent = errMsg;

    // Helpful visual alert with actionable retry
    if (errorType === 'denied') {
      micStatusTitle.textContent = 'Microphone Blocked';
      if (IS_NATIVE_APP) {
        micStatusSubtitle.innerHTML = `Microphone access is off for LyricWave. Open <strong>Settings → Apps → LyricWave → Permissions</strong>, allow <strong>Microphone</strong>, then tap Retry.`;
        showAlert('Microphone permission is off. Allow it in Android Settings → Apps → LyricWave → Permissions, then tap Retry.', 'warning');
      } else {
        micStatusSubtitle.innerHTML = `Microphone access was blocked. Click the <strong>lock/tune icon</strong> in your browser address bar and set Microphone to <strong>Allow</strong>, then tap Retry.`;
        showAlert('Microphone permission blocked. Click the lock icon in the address bar to Allow, then tap Retry.', 'warning');
      }
      if (micActionRow) {
        micActionRow.classList.remove('hidden');
        micActionRow.innerHTML = `<button id="btnMicRetryPermission" class="btn btn-sm btn-spotify" type="button">↻ Retry Mic</button>`;
        const btnRetry = document.getElementById('btnMicRetryPermission');
        if (btnRetry) {
          btnRetry.addEventListener('click', () => {
            micStatusTitle.textContent = 'Tap to Listen';
            micStatusSubtitle.textContent = 'Identifies any song playing from nearby speakers, radio, TV, or vinyl.';
            micActionRow.innerHTML = `<button id="btnMicCancel" class="btn btn-sm btn-ghost" type="button">Cancel</button>`;
            document.getElementById('btnMicCancel')?.addEventListener('click', () => mic.stop());
            mic.start();
          });
        }
      }
    } else if (errorType === 'too_quiet') {
      showAlert('Audio was too quiet to detect music. Move closer to the speaker and tap Listen.', 'warning');
    } else if (errorType === 'no_match') {
      showAlert('No song match found. Try again during the chorus or louder section.', 'warning');
    } else {
      showAlert(errMsg, 'warning');
    }
  }
});

// Explicit user gesture on "Listen"
btnMicListen.addEventListener('click', () => {
  if (mic.isListening) {
    mic.stop();
    micStatusTitle.textContent = 'Tap to Listen';
    micStatusSubtitle.textContent = 'Identifies any song playing from nearby speakers, radio, TV, or vinyl.';
    return;
  }

  // Clear any leftover blocked/error text immediately
  micStatusTitle.textContent = 'Tap to Listen';
  micStatusSubtitle.textContent = 'Identifies any song playing from nearby speakers, radio, TV, or vinyl.';
  micActionRow.innerHTML = `<button id="btnMicCancel" class="btn btn-sm btn-ghost" type="button">Cancel</button>`;
  document.getElementById('btnMicCancel')?.addEventListener('click', () => mic.stop());

  // If user hasn't seen the consent disclosure yet, show modal first
  if (!MicSource.hasConsent()) {
    micConsentBackdrop.classList.remove('hidden');
  } else {
    mic.start();
  }
});

// Cancel button while listening
btnMicCancel.addEventListener('click', () => {
  mic.stop();
  micStatusTitle.textContent = 'Tap to Listen';
  micStatusSubtitle.textContent = 'Listening canceled. Tap to try again.';
});

// Consent Modal Handlers
btnShowMicConsent.addEventListener('click', () => {
  micConsentBackdrop.classList.remove('hidden');
});

btnCloseMicConsent.addEventListener('click', () => {
  micConsentBackdrop.classList.add('hidden');
});

btnCancelMicConsent.addEventListener('click', () => {
  micConsentBackdrop.classList.add('hidden');
});

btnAcceptMicConsent.addEventListener('click', () => {
  MicSource.setConsent(true);
  micConsentBackdrop.classList.add('hidden');
  // Start recording immediately following the user tap
  mic.start();
});

micConsentBackdrop.addEventListener('click', (e) => {
  if (e.target === micConsentBackdrop) {
    micConsentBackdrop.classList.add('hidden');
  }
});

// Re-sync Button (Acoustic re-anchor / song change detection)
if (btnResync) {
  btnResync.addEventListener('click', async () => {
    btnResync.classList.add('syncing');
    btnResync.disabled = true;
    showAlert('Re-listening to room audio to re-sync lyrics...', 'info');

    try {
      await mic.resync();
    } finally {
      setTimeout(() => {
        btnResync.classList.remove('syncing');
        btnResync.disabled = false;
      }, 1000);
    }
  });
}

// Auto Re-listen 2-Minute Toggle
let isAutoRelistenOn = localStorage.getItem('lyricwave_auto_relisten') === 'true';
function updateAutoRelistenUI(enabled) {
  isAutoRelistenOn = enabled;
  localStorage.setItem('lyricwave_auto_relisten', enabled.toString());
  mic.setAutoRelisten(enabled);

  if (autoRelistenLabel) autoRelistenLabel.textContent = enabled ? '2m Active' : 'Off';
  if (autoRelistenDot) {
    autoRelistenDot.classList.toggle('paused', !enabled);
  }
  if (btnToggleAutoRelisten) {
    btnToggleAutoRelisten.classList.toggle('active', enabled);
  }
}
updateAutoRelistenUI(isAutoRelistenOn);

if (btnToggleAutoRelisten) {
  btnToggleAutoRelisten.addEventListener('click', () => {
    updateAutoRelistenUI(!isAutoRelistenOn);
    showAlert(isAutoRelistenOn ? 'Auto re-listening enabled (checks room audio every 2 min).' : 'Auto re-listening turned off.', 'info');
  });
}

// Dismiss manual tap hint banner
if (btnDismissTapBanner) {
  btnDismissTapBanner.addEventListener('click', () => {
    if (tapLineBanner) tapLineBanner.classList.add('hidden');
  });
}

// =====================================================================
// Input Source 2: Manual Search (Direct LRCLIB & iTunes)
// =====================================================================

const searchSource = new SearchSource({
  onError: (errMsg) => {
    showAlert(errMsg, 'warning');
  }
});

searchInput.addEventListener('input', (e) => {
  const query = e.target.value.trim();
  btnClearSearch.classList.toggle('hidden', !query);

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  if (!query) {
    searchRequestSeq++;
    searchResults.innerHTML = `
      <div class="search-prompt">
        <span class="search-prompt-icon">🔍</span>
        <p>Type any song name above to find synced lyrics directly on LRCLIB.</p>
      </div>
    `;
    return;
  }

  searchResults.innerHTML = `
    <div class="search-prompt">
      <div class="spinner" style="margin: 0 auto 0.75rem auto;"></div>
      <p>Searching tracks on LRCLIB & iTunes...</p>
    </div>
  `;

  const requestId = ++searchRequestSeq;
  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await searchTracks(query, 8);
      if (requestId !== searchRequestSeq) return; // a newer search superseded this one
      renderSearchResults(results);
    } catch (err) {
      if (requestId !== searchRequestSeq) return;
      searchResults.innerHTML = `
        <div class="search-prompt">
          <p>Search failed. Please check connection.</p>
        </div>
      `;
    }
  }, 350);
});

btnClearSearch.addEventListener('click', () => {
  searchRequestSeq++; // drop any in-flight results
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchInput.value = '';
  btnClearSearch.classList.add('hidden');
  searchResults.innerHTML = `
    <div class="search-prompt">
      <span class="search-prompt-icon">🔍</span>
      <p>Type any song name above to find synced lyrics directly on LRCLIB.</p>
    </div>
  `;
});

function renderSearchResults(tracks) {
  if (!tracks || tracks.length === 0) {
    searchResults.innerHTML = `
      <div class="search-prompt">
        <p>No tracks found with lyrics. Try another title or artist.</p>
      </div>
    `;
    return;
  }

  searchResults.innerHTML = '';
  const fragment = document.createDocumentFragment();

  tracks.forEach((track) => {
    const item = document.createElement('div');
    item.className = 'search-item';
    const cleanArt = sanitizeUrl(track.albumArt);
    item.innerHTML = `
      <img class="search-item-art" src="${cleanArt || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>'}" alt="" onerror="this.style.display='none'">
      <div class="search-item-info">
        <div class="search-item-title">${escapeHtml(track.title)}</div>
        <div class="search-item-artist">${escapeHtml(track.artist)}</div>
        <div class="search-item-meta">${escapeHtml(track.album || '')} • ${formatMs(track.durationMs)}${track.hasSynced || track.syncedLyrics ? ' <span class="lyrics-badge synced" style="padding:0.1rem 0.4rem;font-size:0.65rem;margin-left:0.35rem;">Synced</span>' : ''}</div>
      </div>
      <div class="search-item-action">
        <button class="btn-start-track" type="button" aria-label="Start lyrics playback">
          <span>▶ Start</span>
        </button>
      </div>
    `;

    const startAction = () => {
      engine.connectSource(searchSource);
      searchSource.selectTrack(track, true);
    };

    item.addEventListener('click', (e) => {
      startAction();
    });

    const startBtn = item.querySelector('.btn-start-track');
    if (startBtn) {
      startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startAction();
      });
    }

    fragment.appendChild(item);
  });

  searchResults.appendChild(fragment);
}

// =====================================================================
// Genius-Themed Charts Section (Top Trending Songs)
// =====================================================================

let currentChartGenre = 'all';
let cachedChartData = null;
let isFetchingCharts = false;
let pendingChartGenre = null;

async function loadCharts(genre = 'all', forceRefresh = false) {
  if (!chartsListContainer) return;
  currentChartGenre = genre;
  if (isFetchingCharts) {
    // Don't drop a genre change made mid-load; reload once the current fetch finishes.
    pendingChartGenre = genre;
    return;
  }

  // Visual loading feedback
  if (btnRefreshCharts) {
    btnRefreshCharts.classList.add('loading');
  }

  chartsListContainer.innerHTML = `
    <div class="charts-loading-state">
      <div class="spinner" style="margin: 0 auto 0.75rem auto;"></div>
      <p>Loading hot chart songs...</p>
    </div>
  `;

  const ITUNES_GENRES = {
    all: '',
    pop: '/genre=14',
    'hip-hop': '/genre=18',
    'r&b': '/genre=15',
    rock: '/genre=21',
    latin: '/genre=12',
    country: '/genre=6'
  };

  try {
    isFetchingCharts = true;

    // Strategy A: Direct client-side fetch to Apple Topsongs RSS (has CORS: *, 0 server latency, and unauthenticated permanent AAC audio streams)
    const genreSeg = ITUNES_GENRES[genre] || '';
    const directRes = await fetch(`https://itunes.apple.com/us/rss/topsongs/limit=25${genreSeg}/json`);
    if (directRes.ok) {
      const dData = await directRes.json();
      const entries = dData?.feed?.entry || [];
      if (entries.length > 0) {
        const clientSongs = entries.map((entry, index) => {
          const title = entry?.['im:name']?.label || 'Unknown Track';
          const artist = entry?.['im:artist']?.label || 'Unknown Artist';
          const album = entry?.['im:collection']?.['im:name']?.label || '';
          const images = entry?.['im:image'] || [];
          const rawArt = images.length > 0 ? images[images.length - 1]?.label || '' : '';
          const highResArt = rawArt.replace('170x170bb', '600x600bb');
          let previewUrl = null;
          const links = entry?.link || [];
          const linkList = Array.isArray(links) ? links : [links];
          for (const l of linkList) {
            const attrs = l?.attributes || {};
            if (attrs['im:assetType'] === 'preview' || attrs.rel === 'enclosure' || (attrs.type && attrs.type.includes('audio'))) {
              previewUrl = attrs.href || null;
              break;
            }
          }
          return {
            rank: index + 1,
            id: `chart_client_${index + 1}`,
            appleId: `${index + 1}`,
            title,
            artist,
            album,
            albumArt: highResArt || rawArt,
            previewUrl,
            durationMs: 30000,
            genre: genre === 'all' ? 'Hot' : genre.toUpperCase(),
            source: 'chart'
          };
        });

        if (chartsUpdatedTag) {
          chartsUpdatedTag.textContent = 'Live Today';
        }
        cachedChartData = { songs: clientSongs, genre };
        if (currentChartGenre === genre) renderCharts(clientSongs);
        return;
      }
    }
  } catch (directErr) {
    console.warn('Direct iTunes RSS client fetch error, falling back to /api/charts:', directErr);
  }

  // Strategy B: Backend Cloudflare Pages Function fallback (/api/charts)
  try {
    const query = new URLSearchParams({
      limit: '25',
      genre: genre,
      v: '3',
      _t: Date.now().toString()
    });

    const apiBase = (typeof CONFIG !== 'undefined' && CONFIG.API_BASE_URL) ? CONFIG.API_BASE_URL : '';
    const res = await fetch(`${apiBase}/api/charts?${query.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to load charts (HTTP ${res.status})`);
    }

    const data = await res.json();
    cachedChartData = data;

    if (chartsUpdatedTag && data.updated) {
      try {
        const d = new Date(data.updated);
        chartsUpdatedTag.textContent = `Updated ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } catch {
        chartsUpdatedTag.textContent = 'Live Today';
      }
    }

    if (currentChartGenre === genre) renderCharts(data.songs || []);
  } catch (err) {
    console.warn('Charts backend load error:', err);

    chartsListContainer.innerHTML = `
      <div class="charts-empty-state">
        <p style="margin-bottom:0.6rem;">⚠️ Unable to load charts right now.</p>
        <button id="btnRetryCharts" class="btn btn-sm btn-ghost" type="button" style="border:1px solid var(--border);">
          ↻ Try Again
        </button>
      </div>
    `;
    const btnRetry = document.getElementById('btnRetryCharts');
    if (btnRetry) {
      btnRetry.addEventListener('click', () => loadCharts(genre, true));
    }
  } finally {
    isFetchingCharts = false;
    if (btnRefreshCharts) {
      btnRefreshCharts.classList.remove('loading');
    }
    if (pendingChartGenre !== null) {
      const next = pendingChartGenre;
      pendingChartGenre = null;
      if (next !== genre) loadCharts(next);
    }
  }
}

function renderCharts(songs) {
  if (!chartsListContainer) return;

  if (!songs || songs.length === 0) {
    chartsListContainer.innerHTML = `
      <div class="charts-empty-state">
        <p>No tracks found for this genre. Check back shortly!</p>
      </div>
    `;
    return;
  }

  chartsListContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();

  songs.forEach((song, idx) => {
    const card = document.createElement('div');
    const rank = song.rank || (idx + 1);
    card.className = `chart-song-card rank-${rank <= 3 ? rank : 'other'}`;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Play #${rank}: ${song.title} by ${song.artist}`);

    const cleanArt = sanitizeUrl(song.albumArt);
    const artHtml = cleanArt
      ? `<img class="chart-song-art" src="${cleanArt}" alt="${escapeHtml(song.title)}" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="chart-song-art" style="display:flex;align-items:center;justify-content:center;font-size:1.1rem;opacity:0.6;">🎵</div>`;

    card.innerHTML = `
      <div class="chart-rank-number">#${rank}</div>
      ${artHtml}
      <div class="chart-song-meta">
        <div class="chart-song-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>
        <div class="chart-song-artist" title="${escapeHtml(song.artist)}">${escapeHtml(song.artist)}</div>
        <div class="chart-song-tag-row">
          <span class="chart-genre-tag">${escapeHtml(song.genre || 'Hot')}</span>
          ${rank <= 5 ? '<span class="chart-fire-tag">🔥 Trending</span>' : ''}
        </div>
      </div>
      <div class="chart-song-action">
        <button class="btn-chart-play" type="button" aria-label="Play synced lyrics for ${escapeHtml(song.title)}">
          <span>▶ Play</span>
        </button>
      </div>
    `;

    const startChartPlayback = () => {
      // Connect searchSource & select this track to launch unified synced lyrics with speaker audio
      engine.connectSource(searchSource);
      searchSource.selectTrack({
        id: song.id || `chart_${song.appleId || idx}`,
        title: song.title,
        artist: song.artist,
        album: song.album || '',
        albumArt: song.albumArt || '',
        previewUrl: song.previewUrl || null,
        durationMs: song.durationMs || 30000,
        // Chart feeds only carry the 30s preview length; the real length comes from LRCLIB.
        durationEstimated: true,
        source: 'chart'
      }, true);
      showAlert(`▶ Lyrics for #${rank}: "${song.title}"`, 'success');
      if (activePlaybackView) {
        activePlaybackView.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

    card.addEventListener('click', startChartPlayback);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        startChartPlayback();
      }
    });

    const playBtn = card.querySelector('.btn-chart-play');
    if (playBtn) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startChartPlayback();
      });
    }

    fragment.appendChild(card);
  });

  chartsListContainer.appendChild(fragment);
}

// Genre filter pills click listener
if (genrePills && genrePills.length > 0) {
  genrePills.forEach((pill) => {
    pill.addEventListener('click', () => {
      genrePills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const genre = pill.dataset.genre || 'all';
      loadCharts(genre);
    });
  });
}

// Refresh button listener
if (btnRefreshCharts) {
  btnRefreshCharts.addEventListener('click', () => {
    loadCharts(currentChartGenre, true);
  });
}

// =====================================================================
// Genius-Themed Music News Section (Rolling Stone & NME)
// =====================================================================

let currentNewsSource = 'all';
let cachedNewsData = null;
let isFetchingNews = false;

async function loadNews(sourceFilter = 'all', forceRefresh = false) {
  if (!newsListContainer) return;
  if (isFetchingNews) return;

  currentNewsSource = sourceFilter;

  if (btnRefreshNews) {
    btnRefreshNews.classList.add('loading');
  }

  newsListContainer.innerHTML = `
    <div class="charts-loading-state">
      <div class="spinner" style="margin: 0 auto 0.75rem auto;"></div>
      <p>Loading fresh music headlines...</p>
    </div>
  `;

  try {
    isFetchingNews = true;
    const query = new URLSearchParams({
      limit: '20'
    });
    if (forceRefresh) {
      query.set('t', Date.now().toString());
    }

    const apiBase = (typeof CONFIG !== 'undefined' && CONFIG.API_BASE_URL) ? CONFIG.API_BASE_URL : '';
    const res = await fetch(`${apiBase}/api/news?${query.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to load news (HTTP ${res.status})`);
    }

    const data = await res.json();
    cachedNewsData = data;

    if (newsUpdatedTag && data.updated) {
      try {
        const d = new Date(data.updated);
        newsUpdatedTag.textContent = `Updated ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } catch {
        newsUpdatedTag.textContent = 'Live Today';
      }
    }

    renderNews(data.articles || [], sourceFilter);
  } catch (err) {
    console.warn('News load error:', err);
    newsListContainer.innerHTML = `
      <div class="charts-empty-state">
        <p style="margin-bottom:0.6rem;">⚠️ Unable to load music news right now.</p>
        <button id="btnRetryNews" class="btn btn-sm btn-ghost" type="button" style="border:1px solid var(--border);">
          ↻ Try Again
        </button>
      </div>
    `;
    const btnRetry = document.getElementById('btnRetryNews');
    if (btnRetry) {
      btnRetry.addEventListener('click', () => loadNews(sourceFilter, true));
    }
  } finally {
    isFetchingNews = false;
    if (btnRefreshNews) {
      btnRefreshNews.classList.remove('loading');
    }
  }
}

function renderNews(articles, sourceFilter = 'all') {
  if (!newsListContainer) return;

  let filtered = articles;
  if (sourceFilter !== 'all') {
    const sLow = sourceFilter.toLowerCase();
    filtered = articles.filter(a => {
      const src = (a.source || '').toLowerCase().replace(/\s+/g, '-');
      return src.includes(sLow);
    });
  }

  if (!filtered || filtered.length === 0) {
    newsListContainer.innerHTML = `
      <div class="charts-empty-state">
        <p>No headlines found for this publication. Check back soon!</p>
      </div>
    `;
    return;
  }

  newsListContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();

  filtered.forEach((article) => {
    const card = document.createElement('a');
    card.className = 'news-article-card';
    card.href = /^https?:\/\//i.test(article.link || '') ? article.link : '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', `${article.title} - ${article.source}`);

    let timeAgo = '';
    if (article.pubDate) {
      try {
        const d = new Date(article.pubDate);
        timeAgo = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      } catch {}
    }

    const cleanImg = sanitizeUrl(article.imageUrl);
    const imgHtml = cleanImg
      ? `<img class="news-article-img" src="${cleanImg}" alt="${escapeHtml(article.title)}" loading="lazy" onerror="this.parentElement.style.display='none'">`
      : `<div class="news-article-img" style="display:flex;align-items:center;justify-content:center;font-size:1.4rem;background:#181b22;">📰</div>`;

    card.innerHTML = `
      <div class="news-article-img-wrap">
        ${imgHtml}
      </div>
      <div class="news-article-content">
        <div>
          <div class="news-article-badge-row">
            <span class="news-source-tag">${escapeHtml(article.source || 'News')}</span>
            ${timeAgo ? `<span class="news-time-tag">• ${escapeHtml(timeAgo)}</span>` : ''}
          </div>
          <div class="news-article-title">${escapeHtml(article.title)}</div>
        </div>
        ${article.excerpt ? `<p class="news-article-excerpt">${escapeHtml(article.excerpt)}</p>` : ''}
      </div>
    `;

    fragment.appendChild(card);
  });

  newsListContainer.appendChild(fragment);
}

// News source filter pills click listener
if (newsFilterPills && newsFilterPills.length > 0) {
  newsFilterPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      newsFilterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const src = pill.dataset.source || 'all';
      if (cachedNewsData && cachedNewsData.articles) {
        renderNews(cachedNewsData.articles, src);
      } else {
        loadNews(src);
      }
    });
  });
}

// News refresh button listener
if (btnRefreshNews) {
  btnRefreshNews.addEventListener('click', () => {
    loadNews(currentNewsSource, true);
  });
}

// =====================================================================
// Input Source 3: Last.fm Live Scrobble (Approximate Mode)
// =====================================================================

const lastfm = new LastFmSource({
  apiKey: CONFIG.LASTFM_API_KEY || undefined,
  pollInterval: 4000,
  onError: (errMsg) => {
    lastfmStatusInfo.classList.remove('hidden');
    lastfmStatusMsg.textContent = errMsg;
    showAlert(errMsg, 'warning');
  }
});

btnConnectLastfm.addEventListener('click', () => {
  const user = lastfmUserInput.value.trim();
  if (!user) {
    showAlert('Please enter your Last.fm username.', 'warning');
    return;
  }
  try {
    lastfm.setUsername(user);
    engine.connectSource(lastfm);
    lastfmStatusInfo.classList.remove('hidden');
    lastfmStatusMsg.textContent = `Polling @${user} scrobbles every 4s...`;
    showAlert(`Connecting to Last.fm as @${user} in Approximate Mode.`, 'info');
  } catch (err) {
    showAlert(err.message, 'warning');
  }
});

if (btnDisconnectLastfm) {
  btnDisconnectLastfm.addEventListener('click', () => {
    lastfm.stop();
    lastfmStatusInfo.classList.add('hidden');
    showAlert('Disconnected from Last.fm.', 'info');
  });
}

// Restore previous Last.fm username if stored
const savedLastFm = lastfm.getUsername();
if (savedLastFm) {
  lastfmUserInput.value = savedLastFm;
}

// =====================================================================
// Input Source 4: Spotify Live Tracking (Private Beta)
// =====================================================================

const spotifySource = new SpotifySource({
  pollInterval: 3000,
  onError: (err) => {
    if (err.message.includes('expired') || err.message.includes('authenticated')) {
      spotifySource.stop();
      logout();
      showSpotifyLoggedOut();
      showAlert('Spotify session expired. Please reconnect.', 'warning');
    }
  }
});

function showSpotifyLoggedIn(profile) {
  spotifyLoggedOut.classList.add('hidden');
  spotifyLoggedIn.classList.remove('hidden');

  const name = profile?.display_name || profile?.id || 'Spotify User';
  userName.textContent = name;

  if (profile?.images && profile.images.length > 0) {
    userAvatar.src = profile.images[0].url;
    userAvatar.classList.remove('hidden');
    avatarFallback.classList.add('hidden');
  } else {
    userAvatar.classList.add('hidden');
    avatarFallback.textContent = name.charAt(0).toUpperCase();
    avatarFallback.classList.remove('hidden');
  }

  // Connect spotifySource to the unified sync engine
  engine.connectSource(spotifySource);
}

function showSpotifyLoggedOut() {
  spotifySource.stop();
  spotifyLoggedIn.classList.add('hidden');
  spotifyLoggedOut.classList.remove('hidden');
}

btnLoginSpotify.addEventListener('click', async () => {
  try {
    btnLoginSpotify.disabled = true;
    btnLoginSpotify.innerHTML = '<div class="spinner"></div><span>Connecting...</span>';
    await initiateLogin();
  } catch (err) {
    btnLoginSpotify.disabled = false;
    btnLoginSpotify.innerHTML = '<span>Connect Spotify</span>';
    showAlert(err.message, 'danger');
  }
});

btnLogoutSpotify.addEventListener('click', () => {
  spotifySource.stop();
  logout();
  showSpotifyLoggedOut();
});

// =====================================================================
// Navigation Tab Switching
// =====================================================================

// Sub-tab state for Connect panel ('lastfm' or 'spotify')
let activeConnectSubTab = localStorage.getItem('lyricwave_connect_subtab') || 'lastfm';

function switchConnectSubTab(subTab) {
  activeConnectSubTab = subTab;
  localStorage.setItem('lyricwave_connect_subtab', subTab);

  if (btnSubLastfm) {
    const isLastfm = subTab === 'lastfm';
    btnSubLastfm.classList.toggle('active', isLastfm);
    btnSubLastfm.setAttribute('aria-selected', isLastfm ? 'true' : 'false');
  }
  if (btnSubSpotify) {
    const isSpotify = subTab === 'spotify';
    btnSubSpotify.classList.toggle('active', isSpotify);
    btnSubSpotify.setAttribute('aria-selected', isSpotify ? 'true' : 'false');
  }
  if (btnSubApple) {
    const isApple = subTab === 'apple';
    btnSubApple.classList.toggle('active', isApple);
    btnSubApple.setAttribute('aria-selected', isApple ? 'true' : 'false');
  }

  if (subPanels.lastfm) subPanels.lastfm.classList.toggle('hidden', subTab !== 'lastfm');
  if (subPanels.spotify) subPanels.spotify.classList.toggle('hidden', subTab !== 'spotify');
  if (subPanels.apple) subPanels.apple.classList.toggle('hidden', subTab !== 'apple');

  // Tear down opposite source
  if (subTab === 'lastfm') {
    if (spotifySource.isRunning) spotifySource.stop();
    if (lastfm.getUsername()) engine.connectSource(lastfm);
    engine.loadOffsetForSource('lastfm');
  } else if (subTab === 'spotify') {
    if (lastfm.isRunning) lastfm.stop();
    if (isAuthenticated()) engine.connectSource(spotifySource);
    engine.loadOffsetForSource('spotify');
  } else if (subTab === 'apple') {
    if (lastfm.isRunning) lastfm.stop();
    if (spotifySource.isRunning) spotifySource.stop();
  }
  updateOffsetUI();
}

if (btnSubLastfm) {
  btnSubLastfm.addEventListener('click', () => switchConnectSubTab('lastfm'));
}
if (btnSubSpotify) {
  btnSubSpotify.addEventListener('click', () => switchConnectSubTab('spotify'));
}
if (btnSubApple) {
  btnSubApple.addEventListener('click', () => switchConnectSubTab('apple'));
}

sourceTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const targetTab = tab.dataset.tab;
    activeTab = targetTab;
    localStorage.setItem(STORAGE_LAST_SOURCE_KEY, targetTab);

    sourceTabs.forEach(t => {
      const isCurrent = t === tab;
      t.classList.toggle('active', isCurrent);
      t.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    });

    Object.keys(tabPanels).forEach(key => {
      if (tabPanels[key]) {
        tabPanels[key].classList.toggle('hidden', key !== targetTab);
      }
    });

    // Tear down previous sources
    if (targetTab !== 'mic') {
      // Also cancels a pending upload and the auto re-listen timer.
      mic.stop();
    }
    if (targetTab !== 'connect' && targetTab !== 'spotify' && spotifySource.isRunning) {
      spotifySource.stop();
    }
    if (targetTab !== 'connect' && targetTab !== 'lastfm' && lastfm.isRunning) {
      lastfm.stop();
    }
    if (targetTab !== 'search' && searchSource.isPlaying) {
      searchSource.stop();
    }

    // Connect appropriate active source
    if (targetTab === 'connect') {
      if (panelConnect) panelConnect.classList.remove('hidden');
      switchConnectSubTab(activeConnectSubTab);
    } else if (targetTab === 'spotify') {
      // Legacy compatibility if tabSpotify is clicked directly
      if (isAuthenticated()) engine.connectSource(spotifySource);
      engine.loadOffsetForSource('spotify');
      updateOffsetUI();
    } else if (targetTab === 'lastfm') {
      // Legacy compatibility if tabLastfm is clicked directly
      if (lastfm.getUsername()) engine.connectSource(lastfm);
      engine.loadOffsetForSource('lastfm');
      updateOffsetUI();
    } else if (targetTab === 'search') {
      engine.connectSource(searchSource);
      engine.loadOffsetForSource('search');
      updateOffsetUI();
    } else if (targetTab === 'charts') {
      engine.connectSource(searchSource);
      engine.loadOffsetForSource('search');
      updateOffsetUI();
      if (!cachedChartData) {
        loadCharts(currentChartGenre);
      }
    } else if (targetTab === 'news') {
      engine.connectSource(searchSource);
      engine.loadOffsetForSource('search');
      updateOffsetUI();
      if (!cachedNewsData) {
        loadNews(currentNewsSource);
      }
    } else if (targetTab === 'mic') {
      engine.connectSource(null);
      engine.loadOffsetForSource('mic');
      updateOffsetUI();
    }
  });
});

// Now Playing compact bar interactions:
// 1. Listen again: triggers microphone listening immediately
if (btnListenAgain) {
  btnListenAgain.addEventListener('click', () => {
    const micTab = document.getElementById('tabMic');
    if (micTab) micTab.click();
    if (!mic.isListening) {
      if (!MicSource.hasConsent()) {
        micConsentBackdrop?.classList.remove('hidden');
      } else {
        mic.start();
      }
    }
  });
}

// 2. Switch source from compact bar: reveals full source nav or cycles
if (btnSwitchSourceCompact) {
  btnSwitchSourceCompact.addEventListener('click', () => {
    // Show active tab panel if hidden
    const activePanel = tabPanels[activeTab] || tabPanels.mic;
    if (activePanel) {
      activePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

// Restore saved source tab on launch
if (activeTab && activeTab !== 'mic') {
  const savedTabBtn = document.querySelector(`.source-tab[data-tab="${activeTab}"]`);
  if (savedTabBtn) {
    savedTabBtn.click();
  }
} else {
  engine.loadOffsetForSource('mic');
  updateOffsetUI();
}

// "Use Spotify Beta" buttons on coming soon panels
document.querySelectorAll('[data-switch-to="spotify"]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const connectTab = document.getElementById('tabConnect');
    if (connectTab) {
      connectTab.click();
      switchConnectSubTab('spotify');
    }
  });
});

// =====================================================================
// Shared Player Scrubber & Controls
// =====================================================================

btnPlayPause.addEventListener('click', () => {
  engine.togglePlay();
});

btnSeekBack.addEventListener('click', () => {
  engine.seekBy(-5);
});

btnSeekForward.addEventListener('click', () => {
  engine.seekBy(5);
});

progressTrack.addEventListener('click', (e) => {
  const rect = progressTrack.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, clickX / rect.width));
  const targetMs = ratio * (engine.durationMs || engine.durationSec * 1000);
  engine.seekMs(targetMs);
});

progressTrack.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    engine.seekBy(-5);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    engine.seekBy(5);
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    engine.togglePlay();
  }
});

// =====================================================================
// Lyrics & OLED Reel Display Rendering
// =====================================================================

function renderLyricsState(lyrics) {
  lineElements = [];
  reelWordElements = [];
  lyricsContent.innerHTML = '';
  lyricsStatusBadge.className = 'lyrics-badge';

  if (!lyrics || lyrics.status === 'loading') {
    lyricsStatusText.textContent = 'Searching lyrics...';
    lyricsContent.innerHTML = `
      <div class="lyrics-skeleton-container" aria-label="Loading lyrics" role="status">
        <div class="skeleton-line" style="width: 78%;"></div>
        <div class="skeleton-line" style="width: 92%;"></div>
        <div class="skeleton-line" style="width: 65%;"></div>
        <div class="skeleton-line" style="width: 84%;"></div>
        <div class="skeleton-line" style="width: 70%;"></div>
      </div>
    `;
    reelLineText.innerHTML = '<span class="reel-placeholder-text">Searching lyrics...</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';
    return;
  }

  if (lyrics.status === 'synced' && lyrics.syncedLines.length > 0) {
    lyricsStatusBadge.classList.add('synced');
    lyricsStatusText.textContent = '✨ Synced Lyrics';

    // If no offset was returned by provider, show "Tap the line you're hearing" banner
    if (tapLineBanner) {
      if (engine.track && engine.track.hasOffset === false) {
        tapLineBanner.classList.remove('hidden');
      } else {
        tapLineBanner.classList.add('hidden');
      }
    }

    const fragment = document.createDocumentFragment();
    lyrics.syncedLines.forEach((line, index) => {
      const el = document.createElement('div');
      el.className = 'lyric-line upcoming-line';
      el.id = `line-${index}`;
      el.textContent = line.text || '♪';

      // Tapping a line performs non-destructive sync alignment (seeks playback without clearing state)
      el.addEventListener('click', () => {
        engine.seekMs(line.timeMs);
        if (tapLineBanner) tapLineBanner.classList.add('hidden');
      });

      fragment.appendChild(el);
      lineElements.push(el);
    });
    lyricsContent.appendChild(fragment);

    reelLineText.innerHTML = '<span class="reel-placeholder-text">♫ Waiting for music...</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = lyrics.syncedLines[0]?.text || '';

  } else if (lyrics.status === 'plain' && lyrics.plainLyrics) {
    lyricsStatusBadge.classList.add('plain');
    lyricsStatusText.textContent = '📄 Plain Lyrics';
    lyricsContent.innerHTML = `<div class="plain-lyrics-wrap">${escapeHtml(lyrics.plainLyrics)}</div>`;
    reelLineText.innerHTML = '<span class="reel-placeholder-text">Plain lyrics (scroll below)</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';

  } else if (lyrics.status === 'instrumental') {
    lyricsStatusBadge.classList.add('instrumental');
    lyricsStatusText.textContent = '🎷 Instrumental';
    lyricsContent.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">🎷</div>
        <div class="lyrics-empty-msg">Instrumental Track</div>
        <p class="lyrics-empty-sub">This recording is registered as instrumental with no spoken lyrics. Enjoy the music!</p>
      </div>
    `;
    reelLineText.innerHTML = '<span class="reel-placeholder-text">🎷 Instrumental</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';

  } else if (lyrics.status === 'error' || lyrics.status === 'quota') {
    lyricsStatusBadge.classList.add('plain');
    const isOffline = !navigator.onLine;
    const isQuota = lyrics.status === 'quota' || (lyrics.message && lyrics.message.includes('429'));
    lyricsStatusText.textContent = isOffline ? '⚠️ Offline' : (isQuota ? '⏳ Provider Busy' : '⚠️ Lyric Error');
    
    let errorTitle = 'Unable to Load Lyrics';
    let errorDesc = escapeHtml(lyrics.message || 'Check your internet connection or try searching again.');
    if (isOffline) {
      errorTitle = 'You are currently offline';
      errorDesc = 'Lyrics could not be retrieved from LRCLIB without an active internet connection.';
    } else if (isQuota) {
      errorTitle = 'Community Lyrics Provider Busy';
      errorDesc = 'LRCLIB is receiving high traffic right now. Please wait a few seconds and tap Retry below.';
    }

    lyricsContent.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">${isOffline ? '📡' : (isQuota ? '⏳' : '⚠️')}</div>
        <div class="lyrics-empty-msg">${errorTitle}</div>
        <p class="lyrics-empty-sub">${errorDesc}</p>
        <button id="btnRetryLyrics" class="btn btn-sm btn-spotify" type="button" style="width:auto;margin-top:0.4rem;">
          ↻ Try Again
        </button>
      </div>
    `;
    const retryBtn = document.getElementById('btnRetryLyrics');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (engine.track) {
          engine.setTrack(engine.track, engine.isPlaying, true);
        }
      });
    }
    reelLineText.innerHTML = '<span class="reel-placeholder-text">Lyrics temporarily unavailable</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';

  } else {
    lyricsStatusText.textContent = 'No Lyrics';
    lyricsContent.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">📝</div>
        <div class="lyrics-empty-msg">No Synced Lyrics Found</div>
        <p class="lyrics-empty-sub">We could not locate synchronized words for this specific release on LRCLIB yet.</p>
        <button id="btnSearchLyricsManual" class="btn btn-sm btn-ghost" type="button" style="border:1px solid var(--border);width:auto;margin-top:0.4rem;">
          🔍 Search Alternative Title
        </button>
      </div>
    `;
    const searchAltBtn = document.getElementById('btnSearchLyricsManual');
    if (searchAltBtn) {
      searchAltBtn.addEventListener('click', () => {
        const searchTab = document.getElementById('tabSearch');
        if (searchTab) searchTab.click();
      });
    }
    reelLineText.innerHTML = '<span class="reel-placeholder-text">No lyrics found on LRCLIB</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';
  }
}

function updateReelLine(lineIndex) {
  const lyrics = engine.lyricsData;
  if (!lyrics || !lyrics.syncedLines) return;
  const lines = lyrics.syncedLines;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    reelLineText.innerHTML = '<span class="reel-placeholder-text">♫ Prelude / Intro</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = lines[0]?.text || '';
    reelWordElements = [];
    reel.setActiveLine(null, -1);
    return;
  }

  const currentLine = lines[lineIndex];
  const nextLineTime = lines[lineIndex + 1]?.timeMs || 0;

  // Subtle pulse animation on line box
  reelLineBox.classList.remove('line-pulse');
  // Trigger reflow to restart animation reliably
  void reelLineBox.offsetWidth;
  reelLineBox.classList.add('line-pulse');
  setTimeout(() => {
    reelLineBox.classList.remove('line-pulse');
  }, 220);

  reelPrevLine.textContent = lines[lineIndex - 1]?.text || '';
  reelNextLine.textContent = lines[lineIndex + 1]?.text || '';

  reel.setActiveLine(currentLine, lineIndex, nextLineTime);

  // Construct word spans for word reveal
  const rawWords = currentLine.text.trim().split(/\s+/).filter(Boolean);
  reelLineText.innerHTML = '';
  reelWordElements = [];

  if (rawWords.length === 0) {
    reelLineText.innerHTML = '<span class="reel-placeholder-text">♪</span>';
    return;
  }

  const fragment = document.createDocumentFragment();
  rawWords.forEach((word) => {
    const span = document.createElement('span');
    span.className = 'reel-word';
    span.textContent = word;
    fragment.appendChild(span);
    reelWordElements.push(span);
  });
  reelLineText.appendChild(fragment);
}

// =====================================================================
// Latency Offset Controls
// =====================================================================

function updateOffsetUI() {
  const ms = engine.getOffset();
  const sec = (ms / 1000).toFixed(1);
  const sign = ms > 0 ? '+' : '';
  const text = `${sign}${sec}s (${sign}${ms} ms)`;

  if (offsetPreviewLabel) offsetPreviewLabel.textContent = `${sign}${sec}s`;
  if (onStageOffsetLabel) onStageOffsetLabel.textContent = `${sign}${sec}s`;
  if (offsetValueText) offsetValueText.textContent = text;
  if (offsetSlider) offsetSlider.value = ms.toString();

  if (settingOffsetSlider) settingOffsetSlider.value = ms.toString();
  if (lblSettingsOffset) lblSettingsOffset.textContent = text;
}

function setOffset(newMs) {
  engine.setOffset(newMs);
  updateOffsetUI();
}

if (btnToggleOffset) {
  btnToggleOffset.addEventListener('click', () => {
    isOffsetDrawerOpen = !isOffsetDrawerOpen;
    offsetDrawer.classList.toggle('hidden', !isOffsetDrawerOpen);
  });
}

if (offsetSlider) offsetSlider.addEventListener('input', (e) => setOffset(parseInt(e.target.value, 10)));
if (btnOffsetMinus) btnOffsetMinus.addEventListener('click', () => setOffset(engine.getOffset() - 100));
if (btnOffsetPlus) btnOffsetPlus.addEventListener('click', () => setOffset(engine.getOffset() + 100));
if (btnOffsetReset) btnOffsetReset.addEventListener('click', () => setOffset(0));

// On-stage live sync nudge controls
if (btnNudgeMinus) btnNudgeMinus.addEventListener('click', () => setOffset(engine.getOffset() - 100));
if (btnNudgePlus) btnNudgePlus.addEventListener('click', () => setOffset(engine.getOffset() + 100));
if (btnNudgeReset) btnNudgeReset.addEventListener('click', () => setOffset(0));

// =====================================================================
// Preferences & Settings Modal
// =====================================================================

/**
 * Album Adaptive Theme Color Extractor
 * Uses an in-memory canvas sampler to extract dominant colors and guarantee WCAG AA contrast
 */
let lastExtractedArtUrl = null;
let currentAdaptivePalette = null;

function getLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getContrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

function extractAdaptiveColors(imgElement) {
  return new Promise((resolve) => {
    if (!imgElement || !imgElement.src || imgElement.naturalWidth === 0) {
      resolve(null);
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const size = 32;
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(imgElement, 0, 0, size, size);

      const imgData = ctx.getImageData(0, 0, size, size).data;
      const colorCounts = new Map();

      // Sample pixels
      for (let i = 0; i < imgData.length; i += 16) {
        const r = imgData[i];
        const g = imgData[i + 1];
        const b = imgData[i + 2];
        const a = imgData[i + 3];
        if (a < 128) continue;

        // Quantize colors to buckets of 32
        const qr = Math.round(r / 32) * 32;
        const qg = Math.round(g / 32) * 32;
        const qb = Math.round(b / 32) * 32;
        const key = `${qr},${qg},${qb}`;
        colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
      }

      // Sort by frequency
      const sorted = [...colorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(entry => entry[0].split(',').map(Number));

      if (sorted.length === 0) {
        resolve(null);
        return;
      }

      const primary = sorted[0];
      const secondary = sorted.length > 1 ? sorted[1] : [primary[1], primary[2], primary[0]];
      const accent = sorted.length > 2 ? sorted[2] : [255 - primary[0], 255 - primary[1], 255 - primary[2]];

      resolve({
        accent: rgbToHex(accent[0], accent[1], accent[2]),
        wave1: rgbToHex(primary[0], primary[1], primary[2]),
        wave2: rgbToHex(secondary[0], secondary[1], secondary[2]),
        bgDark: rgbToHex(Math.min(30, primary[0] * 0.15), Math.min(30, primary[1] * 0.15), Math.min(40, primary[2] * 0.2)),
        rawPrimary: primary
      });
    } catch {
      resolve(null); // Canvas security or cross-origin fallback
    }
  });
}

async function applyAlbumAdaptivePalette(imgSrc) {
  if (currentTheme !== 'adaptive') return;

  if (!imgSrc) {
    // Fall back to Aurora when no art exists
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-contrast');
    document.documentElement.style.removeProperty('--wave-1');
    document.documentElement.style.removeProperty('--wave-2');
    document.documentElement.style.removeProperty('--adaptive-gradient');
    document.documentElement.style.removeProperty('--lyric-active');
    if (stageArtBackdrop) {
      stageArtBackdrop.classList.add('hidden');
      stageArtBackdrop.style.backgroundImage = 'none';
    }
    return;
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = imgSrc;

  img.onload = async () => {
    const palette = await extractAdaptiveColors(img);
    if (!palette) return;
    currentAdaptivePalette = palette;

    const bgLum = getLuminance(15, 18, 28);
    // Contrast check for active line against dark background
    let lyricActiveColor = '#ffffff';
    const whiteLum = getLuminance(255, 255, 255);
    if (getContrastRatio(whiteLum, bgLum) < 4.5) {
      lyricActiveColor = '#ffffff';
    }

    document.documentElement.style.setProperty('--accent', palette.accent);
    document.documentElement.style.setProperty('--accent-contrast', '#050714');
    document.documentElement.style.setProperty('--wave-1', palette.wave1);
    document.documentElement.style.setProperty('--wave-2', palette.wave2);
    document.documentElement.style.setProperty('--lyric-active', lyricActiveColor);
    document.documentElement.style.setProperty(
      '--adaptive-gradient',
      `radial-gradient(ellipse 90% 65% at 50% 0%, ${palette.wave1}44, ${palette.wave2}22 60%, transparent 80%)`
    );

    // Apply subtle blurred cover art behind the stage for Album Adaptive theme
    if (stageArtBackdrop) {
      stageArtBackdrop.style.backgroundImage = `url("${imgSrc}")`;
      stageArtBackdrop.classList.remove('hidden');
    }
  };
}

function applyTheme(themeName) {
  currentTheme = themeName;
  document.documentElement.setAttribute('data-theme', themeName);
  localStorage.setItem(STORAGE_THEME_KEY, themeName);
  reel.setTheme(themeName);

  // Clear or apply adaptive properties
  if (themeName !== 'adaptive') {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-contrast');
    document.documentElement.style.removeProperty('--wave-1');
    document.documentElement.style.removeProperty('--wave-2');
    document.documentElement.style.removeProperty('--adaptive-gradient');
    document.documentElement.style.removeProperty('--lyric-active');
    if (stageArtBackdrop) {
      stageArtBackdrop.classList.add('hidden');
      stageArtBackdrop.style.backgroundImage = 'none';
    }
  } else {
    const currentTrack = engine?.track;
    if (currentTrack?.albumArt) {
      applyAlbumAdaptivePalette(currentTrack.albumArt);
    } else {
      applyAlbumAdaptivePalette(null);
    }
  }

  themePills.forEach((btn) => {
    const isActive = btn.dataset.theme === themeName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });

  // Update theme swatch cards in settings
  if (themeCards && themeCards.length > 0) {
    themeCards.forEach((card) => {
      const isCardActive = card.dataset.themeCard === themeName;
      card.classList.toggle('active', isCardActive);
      card.setAttribute('aria-checked', isCardActive ? 'true' : 'false');
    });
  }

  if (settingThemeSelect) settingThemeSelect.value = themeName;
}

function applyFontScale(percent) {
  currentFontScale = Math.max(50, Math.min(200, percent));
  localStorage.setItem(STORAGE_FONT_SCALE_KEY, currentFontScale.toString());
  document.documentElement.style.setProperty('--lyrics-font-scale', (currentFontScale / 100).toString());
  if (lblFontSize) lblFontSize.textContent = `${currentFontScale}%`;
  if (settingFontSize) settingFontSize.value = currentFontScale.toString();
}

function setWordMode(enabled) {
  isWordMode = enabled;
  localStorage.setItem(STORAGE_WORD_MODE_KEY, enabled.toString());
  reel.setWordByWordMode(enabled);
  btnToggleWordMode.classList.toggle('active', enabled);
  if (settingWordMode) settingWordMode.checked = enabled;
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    if (reelContainer.requestFullscreen) reelContainer.requestFullscreen();
    else if (reelContainer.webkitRequestFullscreen) reelContainer.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}

function trapFocus(modalElement, event) {
  if (event.key !== 'Tab') return;
  const focusables = modalElement.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  if (!focusables || focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (event.shiftKey) {
    if (document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function openSettings() {
  settingsBackdrop.classList.remove('hidden');
  settingsBackdrop.setAttribute('aria-hidden', 'false');
  // Focus the close button or first actionable element
  setTimeout(() => {
    btnCloseSettings?.focus();
  }, 50);
}

function closeSettings() {
  settingsBackdrop.classList.add('hidden');
  settingsBackdrop.setAttribute('aria-hidden', 'true');
  // Always return focus to the gear button on close
  btnOpenSettings?.focus();
}

btnOpenSettings.addEventListener('click', openSettings);
btnCloseSettings.addEventListener('click', closeSettings);
btnDoneSettings.addEventListener('click', closeSettings);

settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === settingsBackdrop) closeSettings();
});

// Focus trap listener inside settings dialog
settingsBackdrop.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    trapFocus(settingsDialog, e);
  }
});

// Shortcuts Cheat-sheet Modal Controls
function openShortcuts() {
  if (shortcutsBackdrop) {
    shortcutsBackdrop.classList.remove('hidden');
    shortcutsBackdrop.setAttribute('aria-hidden', 'false');
    btnCloseShortcuts?.focus();
  }
}

function closeShortcuts() {
  if (shortcutsBackdrop) {
    shortcutsBackdrop.classList.add('hidden');
    shortcutsBackdrop.setAttribute('aria-hidden', 'true');
  }
}

if (btnOpenShortcuts) btnOpenShortcuts.addEventListener('click', openShortcuts);
if (btnCloseShortcuts) btnCloseShortcuts.addEventListener('click', closeShortcuts);
if (btnDoneShortcuts) btnDoneShortcuts.addEventListener('click', closeShortcuts);
if (shortcutsBackdrop) {
  shortcutsBackdrop.addEventListener('click', (e) => {
    if (e.target === shortcutsBackdrop) closeShortcuts();
  });
}

// Mobile Bottom-Sheet Drag Handle Swipe-down Gesture to Dismiss
if (settingsDragHandle && settingsDialog) {
  let touchStartY = 0;
  let touchCurrentY = 0;

  settingsDragHandle.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  settingsDragHandle.addEventListener('touchmove', (e) => {
    touchCurrentY = e.touches[0].clientY;
    const deltaY = touchCurrentY - touchStartY;
    if (deltaY > 0) {
      settingsDialog.style.transform = `translateY(${deltaY}px)`;
    }
  }, { passive: true });

  settingsDragHandle.addEventListener('touchend', () => {
    const deltaY = touchCurrentY - touchStartY;
    settingsDialog.style.transform = '';
    if (deltaY > 60) {
      closeSettings();
    }
    touchStartY = 0;
    touchCurrentY = 0;
  });
}

// Desktop Keyboard Shortcuts & Navigation
window.addEventListener('keydown', (e) => {
  // If user is currently focused on an editable input/textarea/select, don't trigger global hotkeys
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const isInputActive = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || document.activeElement?.isContentEditable;

  // Escape to close any open dialogs or exit fullscreen
  if (e.key === 'Escape') {
    if (!settingsBackdrop.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (shortcutsBackdrop && !shortcutsBackdrop.classList.contains('hidden')) {
      closeShortcuts();
      return;
    }
    if (micConsentBackdrop && !micConsentBackdrop.classList.contains('hidden')) {
      micConsentBackdrop.classList.add('hidden');
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
  }

  if (isInputActive) return;

  // 'Space': Toggle microphone listening (or play/pause if playing a search track)
  if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (searchSource.isPlaying) {
      engine.togglePlay();
    } else {
      btnMicListen?.click();
    }
    return;
  }

  // 'F' or 'f': Fullscreen reel mode toggle
  if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    toggleFullscreen();
    return;
  }

  // 'S' or 's': Settings dialog toggle
  if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (settingsBackdrop.classList.contains('hidden')) {
      openSettings();
    } else {
      closeSettings();
    }
    return;
  }

  // '?' or '/': Open keyboard shortcuts cheat-sheet
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    if (shortcutsBackdrop.classList.contains('hidden')) {
      openShortcuts();
    } else {
      closeShortcuts();
    }
    return;
  }

  // 'ArrowUp': Nudge sync offset later (+100ms)
  if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setOffset(engine.getOffset() + 100);
    return;
  }

  // 'ArrowDown': Nudge sync offset earlier (-100ms)
  if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setOffset(engine.getOffset() - 100);
    return;
  }

  // '[': Decrease lyrics font size by 10%
  if (e.key === '[' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    applyFontScale(Math.max(80, currentFontScale - 10));
    return;
  }

  // ']': Increase lyrics font size by 10%
  if (e.key === ']' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    applyFontScale(Math.min(140, currentFontScale + 10));
    return;
  }
});

// Fullscreen "Reel Mode": 3-second cursor auto-hide
function resetCursorIdleTimer() {
  document.body.classList.remove('cursor-idle');
  if (cursorIdleTimeout) clearTimeout(cursorIdleTimeout);
  if (document.fullscreenElement) {
    cursorIdleTimeout = setTimeout(() => {
      if (document.fullscreenElement) {
        document.body.classList.add('cursor-idle');
      }
    }, 3000);
  }
}

document.addEventListener('mousemove', resetCursorIdleTimer);
document.addEventListener('touchstart', resetCursorIdleTimer, { passive: true });

themePills.forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

btnToggleWordMode.addEventListener('click', () => setWordMode(!isWordMode));
btnFullscreen.addEventListener('click', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
  const isFs = Boolean(document.fullscreenElement);
  document.body.classList.toggle('fullscreen-reel-mode', isFs);
  fsLabel.textContent = isFs ? 'Exit' : 'Fullscreen';
  resetCursorIdleTimer();
  reel.resizeCanvas();

  if (isFs || (engine && engine.isPlaying)) {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
});

// Theme swatch cards in preferences modal
if (themeCards && themeCards.length > 0) {
  themeCards.forEach((card) => {
    card.addEventListener('click', () => {
      const theme = card.dataset.themeCard;
      if (theme) {
        applyTheme(theme);
      }
    });
  });
}

if (settingThemeSelect) {
  settingThemeSelect.addEventListener('change', (e) => applyTheme(e.target.value));
}
if (settingFontSize) {
  settingFontSize.addEventListener('input', (e) => applyFontScale(parseInt(e.target.value, 10)));
}
if (settingWordMode) {
  settingWordMode.addEventListener('change', (e) => setWordMode(e.target.checked));
}
if (settingOffsetSlider) {
  settingOffsetSlider.addEventListener('input', (e) => setOffset(parseInt(e.target.value, 10)));
}
if (btnSettingsOffsetMinus) {
  btnSettingsOffsetMinus.addEventListener('click', () => setOffset(engine.getOffset() - 100));
}
if (btnSettingsOffsetPlus) {
  btnSettingsOffsetPlus.addEventListener('click', () => setOffset(engine.getOffset() + 100));
}
if (btnSettingsOffsetReset) {
  btnSettingsOffsetReset.addEventListener('click', () => setOffset(0));
}

if (settingRecognitionProvider) {
  const currentProvider = localStorage.getItem('lyricwave_recognition_provider') || CONFIG.RECOGNITION_PROVIDER || 'acrcloud';
  settingRecognitionProvider.value = currentProvider;

  settingRecognitionProvider.addEventListener('change', (e) => {
    const selected = e.target.value;
    mic.setProvider(selected);
    showAlert(`Recognition engine switched to ${selected === 'audd' ? 'AudD' : 'ACRCloud'}.`, 'info');
  });
}

if (settingDebugMode) {
  settingDebugMode.addEventListener('change', (e) => {
    diagnosticsDrawer?.classList.toggle('hidden', !e.target.checked);
  });
}


// "Clear All Data" handler: wipes everything LyricWave keeps on this device.
async function clearAllLocalData() {
  try { mic.stop(); } catch {}
  try { engine.stop(); } catch {}
  try { logout(); } catch {}            // Spotify tokens
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('lyricwave_'))
      .forEach((k) => localStorage.removeItem(k));
  } catch {}
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith('lyricwave_'))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {}
  const dropDb = (name) => new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
  if (typeof indexedDB !== 'undefined') {
    await Promise.all([dropDb('LyricWaveDB'), dropDb('LyricWaveAuthDB')]);
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('lyricwave')).map((k) => caches.delete(k)));
    }
  } catch {}
}

const btnClearAllData = document.getElementById('btnClearAllData');
if (btnClearAllData) {
  let clearArmedTimer = null;
  btnClearAllData.addEventListener('click', async () => {
    if (!clearArmedTimer) {
      btnClearAllData.textContent = 'Tap again to erase';
      clearArmedTimer = setTimeout(() => {
        clearArmedTimer = null;
        btnClearAllData.textContent = 'Clear All Data';
      }, 4000);
      return;
    }
    clearTimeout(clearArmedTimer);
    clearArmedTimer = null;
    btnClearAllData.disabled = true;
    await clearAllLocalData();
    window.location.reload();
  });
}

// "Reset to defaults" handler
if (btnResetDefaults) {
  btnResetDefaults.addEventListener('click', () => {
    // 1. Reset theme to default (prefers-color-scheme)
    const defTheme = getDefaultTheme();
    applyTheme(defTheme);

    // 2. Reset font scale to 100%
    applyFontScale(100);

    // 3. Reset word-by-word reveal to true
    setWordMode(true);

    // 4. Reset sync latency offset to 0
    setOffset(0);

    // 5. Turn off debug diagnostics
    if (settingDebugMode) {
      settingDebugMode.checked = false;
      diagnosticsDrawer?.classList.add('hidden');
    }

    showAlert('Preferences reset to default values.', 'info');
  });
}

// =====================================================================
// PWA & Offline Support
// =====================================================================

function setupPWA() {
  if (IS_NATIVE_APP) {
    // Assets are bundled in the APK. A service worker here would bypass the native asset
    // loader and could serve stale files after an app update, so make sure none is active.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations?.()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
    return;
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        // Check for service worker updates immediately on page load
        if (reg) {
          reg.update().catch(() => {});
        }
      }).catch(() => {});
    });

    // Auto refresh when a newly installed service worker takes control
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btnInstallPwa.classList.remove('hidden');
  });

  btnInstallPwa.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') btnInstallPwa.classList.add('hidden');
    deferredInstallPrompt = null;
  });

  window.addEventListener('appinstalled', () => {
    btnInstallPwa.classList.add('hidden');
    deferredInstallPrompt = null;
  });
}

function setupNetworkMonitoring() {
  const updateOnline = () => {
    if (!navigator.onLine) {
      offlineBanner.classList.remove('hidden', 'recovered');
      offlineBannerText.textContent = 'You are offline. Cached lyrics are available.';
    } else {
      if (!offlineBanner.classList.contains('hidden')) {
        offlineBanner.classList.add('recovered');
        offlineBannerText.textContent = '✓ Back online!';
        setTimeout(() => offlineBanner.classList.add('hidden'), 3000);
      }
    }
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  if (!navigator.onLine) updateOnline();
}

function showAlert(message, type = 'info') {
  alertContainer.className = `alert alert-${type}`;
  alertContainer.innerHTML = `
    <div class="alert-content">
      <span>${escapeHtml(message)}</span>
    </div>
    <button class="alert-close" type="button" aria-label="Close">&times;</button>
  `;
  alertContainer.classList.remove('hidden');

  const closeBtn = alertContainer.querySelector('.alert-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => alertContainer.classList.add('hidden'));
  }
}

function formatMs(ms) {
  if (!ms || isNaN(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) {
    return trimmed;
  }
  return '';
}

// =====================================================================
// Initialize App
// =====================================================================

async function init() {
  setupPWA();
  setupNetworkMonitoring();

  applyTheme(currentTheme);
  applyFontScale(currentFontScale);
  setWordMode(isWordMode);
  updateOffsetUI();
  renderRecentSongs();

  // Setup Developer Mode Banner (Active ONLY on localhost or with ?dev=1)
  if (isDevMode()) {
    const isConfigured = Boolean(CONFIG.CLIENT_ID && CONFIG.CLIENT_ID !== 'YOUR_SPOTIFY_CLIENT_ID');
    devModeBanner.classList.remove('hidden');

    if (isConfigured) {
      devClientIdStatus.className = 'dev-status-row ok';
      devClientIdStatus.innerHTML = '<span>✓ Client ID: Configured</span>';
    } else {
      devClientIdStatus.className = 'dev-status-row warn';
      devClientIdStatus.innerHTML = '<span>⚠️ Client ID: Unconfigured in config.js</span>';
    }

    devRedirectStatus.className = 'dev-status-row ok';
    devRedirectStatus.innerHTML = `<span>✓ Redirect URI: ${escapeHtml(CONFIG.REDIRECT_URI)}</span>`;
  } else {
    devModeBanner.classList.add('hidden');
  }

  // Check Spotify callback & auth state
  try {
    const callbackResult = await handleRedirectCallback();
    if (callbackResult.status === 'success') {
      showAlert('Connected to Spotify successfully!', 'info');
      document.getElementById('tabSpotify').click();
    } else if (callbackResult.status === 'error') {
      showAlert(callbackResult.error, 'danger');
      document.getElementById('tabSpotify').click();
    }
  } catch (err) {
    console.warn('Callback error:', err);
  }

  if (isAuthenticated()) {
    try {
      let profile = getStoredUserProfile() || await fetchUserProfile();
      showSpotifyLoggedIn(profile);
    } catch {
      showSpotifyLoggedOut();
    }
  } else {
    showSpotifyLoggedOut();
  }

  // 6. First-Run Onboarding Hint
  if (firstRunHint && btnDismissFirstRun) {
    const isDismissed = localStorage.getItem(STORAGE_FIRST_RUN_DISMISSED_KEY) === 'true';
    if (!isDismissed) {
      firstRunHint.classList.remove('hidden');
    }
    btnDismissFirstRun.addEventListener('click', () => {
      firstRunHint.classList.add('hidden');
      localStorage.setItem(STORAGE_FIRST_RUN_DISMISSED_KEY, 'true');
    });
  }

  // 7. Share Button: Copies a deep link (?q=artist+title)
  if (btnShareSong) {
    btnShareSong.addEventListener('click', async () => {
      const track = engine.track;
      if (!track || !track.title) {
        showAlert('No track is currently loaded to share.', 'warning');
        return;
      }
      const artist = track.artist || track.artists || '';
      const query = `${artist} ${track.title}`.trim();
      const shareBase = IS_NATIVE_APP
        ? (CONFIG.PUBLIC_WEB_URL || 'https://lyricwave.pages.dev/')
        : window.location.origin + window.location.pathname;
      const url = new URL(shareBase);
      url.searchParams.set('q', query);
      const shareUrl = url.toString();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(shareUrl);
          showAlert(`Copied share link for "${track.title}"!`, 'info');
        } catch {
          prompt('Copy this share link:', shareUrl);
        }
      } else {
        prompt('Copy this share link:', shareUrl);
      }
    });
  }

  // 8. Deep-Link Query (?q=artist+title) support: opens app on Search with that song loaded
  const urlParams = new URLSearchParams(window.location.search);
  const deepQuery = urlParams.get('q');
  if (deepQuery && deepQuery.trim()) {
    const searchTab = document.getElementById('tabSearch');
    if (searchTab) searchTab.click();
    if (searchInput) {
      searchInput.value = deepQuery.trim();
      btnClearSearch?.classList.remove('hidden');
      searchResults.innerHTML = `
        <div class="search-prompt">
          <div class="spinner" style="margin: 0 auto 0.75rem auto;"></div>
          <p>Loading shared song "${escapeHtml(deepQuery)}"...</p>
        </div>
      `;
      try {
        const results = await searchTracks(deepQuery.trim(), 8);
        renderSearchResults(results);
        if (results && results.length > 0) {
          // Select and auto-start first matched track
          engine.connectSource(searchSource);
          searchSource.selectTrack(results[0], true);
        }
      } catch (err) {
        console.warn('Deep query search failed:', err);
      }
    }
  }

  // 9. Restore previously selected tab if saved (e.g. charts, search, mic)
  if (!deepQuery && activeTab) {
    const tabToRestore = document.querySelector(`.source-tab[data-tab="${activeTab}"]`);
    if (tabToRestore && activeTab !== 'mic') {
      tabToRestore.click();
    }
  }

  // 10. User Account Management (Sign Up / Log In)
  setupUserAuth();
}

function setupUserAuth() {
  const btnOpenAuth = document.getElementById('btnOpenAuth');
  const authBackdrop = document.getElementById('authBackdrop');
  const btnCloseAuth = document.getElementById('btnCloseAuth');
  const userAccountBtnLabel = document.getElementById('userAccountBtnLabel');
  
  const authLoggedOutView = document.getElementById('authLoggedOutView');
  const authLoggedInView = document.getElementById('authLoggedInView');
  const authTabLogin = document.getElementById('authTabLogin');
  const authTabSignup = document.getElementById('authTabSignup');
  const authNameGroup = document.getElementById('authNameGroup');
  const authModalTitle = document.getElementById('authHeaderLabel');
  const authErrorMsg = document.getElementById('authErrorMsg');
  const authForm = document.getElementById('authForm');
  const authInputName = document.getElementById('authInputName');
  const authInputEmail = document.getElementById('authInputEmail');
  const authInputPassword = document.getElementById('authInputPassword');
  const btnSubmitAuth = document.getElementById('btnSubmitAuth');
  
  const userProfileInitial = document.getElementById('userProfileInitial');
  const userProfileName = document.getElementById('userProfileName');
  const userProfileEmail = document.getElementById('userProfileEmail');
  const btnUserLogOut = document.getElementById('btnUserLogOut');

  let isSignUpMode = false;

  function updateAuthUI() {
    const user = getCurrentUser();
    if (user) {
      if (userAccountBtnLabel) userAccountBtnLabel.textContent = user.displayName || 'Account';
      authLoggedOutView?.classList.add('hidden');
      authLoggedInView?.classList.remove('hidden');
      if (userProfileInitial) userProfileInitial.textContent = (user.displayName || user.email || 'U')[0].toUpperCase();
      if (userProfileName) userProfileName.textContent = user.displayName || 'User';
      if (userProfileEmail) userProfileEmail.textContent = user.email || '';
    } else {
      if (userAccountBtnLabel) userAccountBtnLabel.textContent = 'Log In';
      authLoggedOutView?.classList.remove('hidden');
      authLoggedInView?.classList.add('hidden');
    }
  }

  function setMode(signUpMode) {
    isSignUpMode = signUpMode;
    authErrorMsg?.classList.add('hidden');
    if (isSignUpMode) {
      authTabSignup?.style.setProperty('background', 'var(--accent)');
      authTabSignup?.style.setProperty('color', 'var(--accent-contrast)');
      authTabLogin?.style.setProperty('background', 'transparent');
      authTabLogin?.style.setProperty('color', 'var(--text-muted)');
      authNameGroup?.classList.remove('hidden');
      if (authModalTitle) authModalTitle.textContent = 'Create LyricWave Account';
      if (btnSubmitAuth) btnSubmitAuth.textContent = 'Sign Up';
    } else {
      authTabLogin?.style.setProperty('background', 'var(--accent)');
      authTabLogin?.style.setProperty('color', 'var(--accent-contrast)');
      authTabSignup?.style.setProperty('background', 'transparent');
      authTabSignup?.style.setProperty('color', 'var(--text-muted)');
      authNameGroup?.classList.add('hidden');
      if (authModalTitle) authModalTitle.textContent = 'Log In to LyricWave';
      if (btnSubmitAuth) btnSubmitAuth.textContent = 'Log In';
    }
  }

  btnOpenAuth?.addEventListener('click', () => {
    updateAuthUI();
    authBackdrop?.classList.remove('hidden');
  });

  btnCloseAuth?.addEventListener('click', () => {
    authBackdrop?.classList.add('hidden');
  });

  authBackdrop?.addEventListener('click', (e) => {
    if (e.target === authBackdrop) authBackdrop.classList.add('hidden');
  });

  authTabLogin?.addEventListener('click', () => setMode(false));
  authTabSignup?.addEventListener('click', () => setMode(true));

  btnSubmitAuth?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (authErrorMsg) authErrorMsg.classList.add('hidden');
    const email = authInputEmail?.value.trim() || '';
    const password = authInputPassword?.value || '';
    const name = authInputName?.value.trim() || '';

    btnSubmitAuth.disabled = true;
    const origText = btnSubmitAuth.textContent;
    btnSubmitAuth.textContent = isSignUpMode ? 'Creating account...' : 'Logging in...';

    try {
      if (isSignUpMode) {
        const user = await signUp({ name, email, password });
        showAlert(`Welcome to LyricWave, ${user.displayName}!`, 'info');
      } else {
        const user = await logIn({ email, password });
        showAlert(`Welcome back, ${user.displayName}!`, 'info');
      }
      authInputPassword.value = '';
      updateAuthUI();
      authBackdrop?.classList.add('hidden');
    } catch (err) {
      if (authErrorMsg) {
        authErrorMsg.textContent = err.message;
        authErrorMsg.classList.remove('hidden');
      }
    } finally {
      btnSubmitAuth.disabled = false;
      btnSubmitAuth.textContent = origText;
    }
  });

  btnUserLogOut?.addEventListener('click', () => {
    logOut();
    updateAuthUI();
    showAlert('Logged out successfully.', 'info');
  });

  // Delete Account: two taps (no native confirm() dialog, which is unreliable in WebView).
  const btnDeleteAccount = document.getElementById('btnDeleteAccount');
  let deleteArmedTimer = null;
  btnDeleteAccount?.addEventListener('click', async () => {
    if (!deleteArmedTimer) {
      btnDeleteAccount.textContent = 'Tap again to permanently delete';
      deleteArmedTimer = setTimeout(() => {
        deleteArmedTimer = null;
        btnDeleteAccount.textContent = 'Delete Account';
      }, 4000);
      return;
    }
    clearTimeout(deleteArmedTimer);
    deleteArmedTimer = null;
    btnDeleteAccount.textContent = 'Delete Account';
    await deleteCurrentAccount();
    updateAuthUI();
    authBackdrop?.classList.add('hidden');
    showAlert('Your LyricWave account was deleted from this device.', 'info');
  });

  // Initial check on load
  updateAuthUI();
}

document.addEventListener('DOMContentLoaded', init);

