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

// DOM Elements: Navigation Tabs
const sourceTabs = document.querySelectorAll('.source-tab');
const tabPanels = {
  mic: document.getElementById('panelMic'),
  search: document.getElementById('panelSearch'),
  lastfm: document.getElementById('panelLastfm'),
  spotify: document.getElementById('panelSpotify')
};

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

// DOM Elements: Synced Lyrics View
const lyricsStatusBadge = document.getElementById('lyricsStatusBadge');
const lyricsStatusText = document.getElementById('lyricsStatusText');
const lyricsViewport = document.getElementById('lyricsViewport');
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
const settingFontSize = document.getElementById('settingFontSize');
const lblFontSize = document.getElementById('lblFontSize');
const settingWordMode = document.getElementById('settingWordMode');
const settingOffsetSlider = document.getElementById('settingOffsetSlider');
const btnSettingsOffsetMinus = document.getElementById('btnSettingsOffsetMinus');
const btnSettingsOffsetPlus = document.getElementById('btnSettingsOffsetPlus');
const btnSettingsOffsetReset = document.getElementById('btnSettingsOffsetReset');
const lblSettingsOffset = document.getElementById('lblSettingsOffset');
const settingDebugMode = document.getElementById('settingDebugMode');
const diagnosticsDrawer = document.getElementById('diagnosticsDrawer');
const dbgPositionMs = document.getElementById('dbgPositionMs');
const dbgEffectiveMs = document.getElementById('dbgEffectiveMs');
const dbgActiveLine = document.getElementById('dbgActiveLine');
const dbgSource = document.getElementById('dbgSource');

// Configuration & Storage Keys
const STORAGE_THEME_KEY = 'lyricwave_theme';
const STORAGE_WORD_MODE_KEY = 'lyricwave_word_mode';
const STORAGE_FONT_SCALE_KEY = 'lyricwave_font_scale';
const STORAGE_LAST_SOURCE_KEY = 'lyricwave_last_source';

// Application State
let activeTab = localStorage.getItem(STORAGE_LAST_SOURCE_KEY) || 'mic';
let isOffsetDrawerOpen = false;
let currentTheme = localStorage.getItem(STORAGE_THEME_KEY) || 'pixel';
let isWordMode = localStorage.getItem(STORAGE_WORD_MODE_KEY) !== 'false';
let currentFontScale = parseInt(localStorage.getItem(STORAGE_FONT_SCALE_KEY) || '100', 10);
let deferredInstallPrompt = null;
let searchDebounceTimer = null;
let lineElements = [];
let reelWordElements = [];

/**
 * Check if Developer Mode is active (strictly when explicitly requested via ?dev=1)
 */
function isDevMode() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('dev') === '1';
}

// =====================================================================
// Instantiate Core Components
// =====================================================================

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
    } else {
      trackArt.classList.add('hidden');
      artPlaceholder.classList.remove('hidden');
    }

    requestAnimationFrame(() => reel.resizeCanvas());
  },

  onPlaybackChange: (isPlaying) => {
    if (isPlaying) {
      playStateDot.classList.remove('paused');
      playStateText.textContent = 'Playing';
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
    } else {
      playStateDot.classList.add('paused');
      playStateText.textContent = 'Paused';
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
    }
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

    if (lineIndex >= 0 && lineElements[lineIndex]) {
      lineElements[lineIndex].scrollIntoView({
        behavior: 'smooth',
        block: 'center'
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
  },

  onSongEnd: (finishedTrack) => {
    // If user is on the Microphone source, auto re-listen to detect the next song
    if (activeTab === 'mic' && !mic.isListening) {
      micStatusTitle.textContent = 'Song Finished — Listening for next song...';
      showAlert(`Finished "${finishedTrack.title}". Listening for the next song...`, 'info');
      mic.start();
    }
  }
});

// Start the engine loop
engine.start();

// =====================================================================
// Input Source 1: Microphone Recognition
// =====================================================================

const mic = new MicSource({
  onStatusChange: (statusText, statusType) => {
    micStatusSubtitle.textContent = statusText;
    if (statusType === 'success') {
      micStatusTitle.textContent = 'Song Recognized!';
    } else if (statusType === 'working') {
      micStatusTitle.textContent = 'Listening...';
    }
  },

  onAudioLevel: (normalizedLevel) => {
    // 1. Scale microphone orb gently
    const scale = 1 + (normalizedLevel * 0.22);
    btnMicListen.style.transform = `scale(${scale})`;

    // 2. Drive live audio level meter width
    if (micLevelFill) {
      const pct = Math.min(100, Math.round(normalizedLevel * 100));
      micLevelFill.style.width = `${pct}%`;
    }
  },

  onCountdown: (secondsRemaining) => {
    if (micCountdownText) {
      micCountdownText.textContent = `Listening... ${secondsRemaining}s`;
    }
  },

  onListeningStateChange: (isListening) => {
    btnMicListen.classList.toggle('listening', isListening);
    micCountdownWrap.classList.toggle('hidden', !isListening);
    micLevelMeterWrap.classList.toggle('hidden', !isListening);
    micActionRow.classList.toggle('hidden', !isListening);

    if (!isListening) {
      btnMicListen.style.transform = '';
      if (micLevelFill) micLevelFill.style.width = '0%';
    }
  },

  onTrackChange: (track) => {
    micStatusTitle.textContent = 'Song Recognized!';
    micStatusSubtitle.textContent = `${track.title} by ${track.artist}`;

    // Pass identified track directly into the unified sync engine
    engine.setTrack(track, true);
  },

  onError: (errMsg, errorType) => {
    btnMicListen.classList.remove('listening');
    btnMicListen.style.transform = '';
    micStatusTitle.textContent = 'Tap to Listen';
    micStatusSubtitle.textContent = errMsg;

    // Helpful visual alert with actionable retry
    if (errorType === 'denied') {
      micStatusTitle.textContent = 'Microphone Blocked';
      micStatusSubtitle.innerHTML = `Microphone access was blocked. Click the <strong>lock/tune icon</strong> in your browser address bar and set Microphone to <strong>Allow</strong>, then tap Retry.`;
      showAlert('Microphone permission blocked. Click the lock icon in the address bar to Allow, then tap Retry.', 'warning');
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

  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await searchTracks(query, 8);
      renderSearchResults(results);
    } catch (err) {
      searchResults.innerHTML = `
        <div class="search-prompt">
          <p>Search failed. Please check connection.</p>
        </div>
      `;
    }
  }, 350);
});

btnClearSearch.addEventListener('click', () => {
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
    item.innerHTML = `
      <img class="search-item-art" src="${track.albumArt || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>'}" alt="" onerror="this.style.display='none'">
      <div class="search-item-info">
        <div class="search-item-title">${escapeHtml(track.title)}</div>
        <div class="search-item-artist">${escapeHtml(track.artist)}</div>
        <div class="search-item-meta">${escapeHtml(track.album || '')} • ${formatMs(track.durationMs)}</div>
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
// Input Source 3: Last.fm Live Scrobble (Approximate Mode)
// =====================================================================

const lastfm = new LastFmSource({
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
  lastfm.setUsername(user);
  engine.connectSource(lastfm);
  lastfmStatusInfo.classList.remove('hidden');
  lastfmStatusMsg.textContent = `Polling @${user} scrobbles every 4s...`;
  showAlert(`Connecting to Last.fm as @${user} in Approximate Mode.`, 'info');
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
      tabPanels[key].classList.toggle('hidden', key !== targetTab);
    });

    // Update active offset for newly switched source
    engine.loadOffsetForSource(targetTab);
    updateOffsetUI();
  });
});

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
    const spotifyTab = document.getElementById('tabSpotify');
    if (spotifyTab) spotifyTab.click();
  });
});

// =====================================================================
// Shared Player Scrubber & Controls
// =====================================================================

btnPlayPause.addEventListener('click', () => {
  engine.togglePlay();
});

btnSeekBack.addEventListener('click', () => {
  engine.seekBy(-5000);
});

btnSeekForward.addEventListener('click', () => {
  engine.seekBy(5000);
});

progressTrack.addEventListener('click', (e) => {
  const rect = progressTrack.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, clickX / rect.width));
  const targetMs = ratio * engine.durationMs;
  engine.seek(targetMs);
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
      <div class="lyrics-empty-state">
        <div class="spinner" style="margin-bottom:0.5rem;"></div>
        <div class="lyrics-empty-msg">Fetching synchronized lyrics from LRCLIB...</div>
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

      // Clicking any lyric line seeks to that line and locks sync
      el.addEventListener('click', () => {
        engine.seek(line.timeMs);
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
        <div class="lyrics-empty-msg">Instrumental track — enjoy the music!</div>
      </div>
    `;
    reelLineText.innerHTML = '<span class="reel-placeholder-text">🎷 Instrumental</span>';
    reelPrevLine.textContent = '';
    reelNextLine.textContent = '';

  } else if (lyrics.status === 'error' || lyrics.status === 'quota') {
    lyricsStatusBadge.classList.add('plain');
    lyricsStatusText.textContent = lyrics.status === 'quota' ? '⚠️ Quota Limit' : '⚠️ Lyric Error';
    const isQuota = lyrics.status === 'quota' || (lyrics.message && lyrics.message.includes('429'));
    lyricsContent.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">${isQuota ? '⏳' : '⚠️'}</div>
        <div class="lyrics-empty-msg" style="font-weight:600; color:var(--text-primary); margin-bottom:0.25rem;">
          ${isQuota ? 'LRCLIB Rate Limit Reached' : 'Unable to Load Lyrics'}
        </div>
        <p style="font-size:0.8rem; color:var(--text-secondary); max-width:280px; margin-bottom:0.75rem;">
          ${isQuota 
            ? 'The community lyrics provider is temporarily busy. Please wait 15 seconds before retrying.' 
            : escapeHtml(lyrics.message || 'Check your internet connection or try searching again.')}
        </p>
        <button id="btnRetryLyrics" class="btn btn-sm btn-ghost" type="button" style="border:1px solid var(--border-subtle);">
          ↻ Retry Lyrics
        </button>
      </div>
    `;
    const retryBtn = document.getElementById('btnRetryLyrics');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (engine.track) {
          engine.setTrack(engine.track, engine.isPlaying);
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
        <div class="lyrics-empty-msg" style="font-weight:600; color:var(--text-primary); margin-bottom:0.25rem;">
          No Lyrics Found
        </div>
        <p style="font-size:0.8rem; color:var(--text-secondary); max-width:280px; margin-bottom:0.75rem;">
          ${escapeHtml(lyrics.message || 'No synchronized or plain lyrics currently exist on LRCLIB for this track.')}
        </p>
        <button id="btnSearchLyricsManual" class="btn btn-sm btn-ghost" type="button" style="border:1px solid var(--border-subtle);">
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

  // Pulse animation on line box
  reelLineBox.classList.add('line-pulse');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      reelLineBox.classList.remove('line-pulse');
    });
  });

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

  offsetPreviewLabel.textContent = `${sign}${sec}s`;
  offsetValueText.textContent = text;
  offsetSlider.value = ms.toString();

  if (settingOffsetSlider) settingOffsetSlider.value = ms.toString();
  if (lblSettingsOffset) lblSettingsOffset.textContent = text;
}

function setOffset(newMs) {
  engine.setOffset(newMs);
  updateOffsetUI();
}

btnToggleOffset.addEventListener('click', () => {
  isOffsetDrawerOpen = !isOffsetDrawerOpen;
  offsetDrawer.classList.toggle('hidden', !isOffsetDrawerOpen);
});

offsetSlider.addEventListener('input', (e) => setOffset(parseInt(e.target.value, 10)));
btnOffsetMinus.addEventListener('click', () => setOffset(engine.getOffset() - 100));
btnOffsetPlus.addEventListener('click', () => setOffset(engine.getOffset() + 100));
btnOffsetReset.addEventListener('click', () => setOffset(0));

// =====================================================================
// Preferences & Settings Modal
// =====================================================================

function applyTheme(themeName) {
  currentTheme = themeName;
  document.documentElement.setAttribute('data-theme', themeName);
  localStorage.setItem(STORAGE_THEME_KEY, themeName);
  reel.setTheme(themeName);

  themePills.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === themeName);
  });
  if (settingThemeSelect) settingThemeSelect.value = themeName;
}

function applyFontScale(percent) {
  currentFontScale = Math.max(80, Math.min(140, percent));
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

btnOpenSettings.addEventListener('click', () => {
  settingsBackdrop.classList.remove('hidden');
});

btnCloseSettings.addEventListener('click', () => {
  settingsBackdrop.classList.add('hidden');
});

btnDoneSettings.addEventListener('click', () => {
  settingsBackdrop.classList.add('hidden');
});

settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === settingsBackdrop) settingsBackdrop.classList.add('hidden');
});

themePills.forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

btnToggleWordMode.addEventListener('click', () => setWordMode(!isWordMode));
btnFullscreen.addEventListener('click', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
  const isFs = Boolean(document.fullscreenElement);
  fsLabel.textContent = isFs ? 'Exit' : 'Fullscreen';
  reel.resizeCanvas();
});

settingThemeSelect.addEventListener('change', (e) => applyTheme(e.target.value));
settingFontSize.addEventListener('input', (e) => applyFontScale(parseInt(e.target.value, 10)));
settingWordMode.addEventListener('change', (e) => setWordMode(e.target.checked));
settingOffsetSlider.addEventListener('input', (e) => setOffset(parseInt(e.target.value, 10)));
btnSettingsOffsetMinus.addEventListener('click', () => setOffset(engine.getOffset() - 100));
btnSettingsOffsetPlus.addEventListener('click', () => setOffset(engine.getOffset() + 100));
btnSettingsOffsetReset.addEventListener('click', () => setOffset(0));

settingDebugMode.addEventListener('change', (e) => {
  diagnosticsDrawer.classList.toggle('hidden', !e.target.checked);
});

// =====================================================================
// PWA & Offline Support
// =====================================================================

function setupPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
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
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
}

document.addEventListener('DOMContentLoaded', init);
