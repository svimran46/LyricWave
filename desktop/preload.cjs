const { contextBridge, ipcRenderer } = require('electron');

// Latest OS media-session snapshot, pushed by the main process. The Android-style bridge below is
// synchronous (getNowPlaying() returns JSON), so it answers from this cache and asks for a
// refresh in the background.
let nowPlayingSnap = null;
let nowPlayingSupported = ['win32', 'darwin', 'linux'].includes(process.platform);
ipcRenderer.on('desktop:now-playing', (_e, snap) => { nowPlayingSnap = snap; });
function refreshNowPlaying() {
  ipcRenderer.invoke('desktop:now-playing').then((snap) => { nowPlayingSnap = snap; }).catch(() => {});
}
function currentNowPlaying() {
  refreshNowPlaying();
  if (!nowPlayingSnap) return { access: nowPlayingSupported, active: false };
  // Extrapolate a playing track's position from when the snapshot was taken.
  const snap = { ...nowPlayingSnap };
  if (snap.isPlaying && Number.isFinite(snap.positionMs) && snap.capturedAt) {
    snap.positionMs += Math.max(0, Date.now() - snap.capturedAt);
    if (snap.durationMs > 0) snap.positionMs = Math.min(snap.positionMs, snap.durationMs);
  }
  return snap;
}

// Expose Desktop API
const desktopAPI = {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('desktop:minimize'),
  maximize: () => ipcRenderer.send('desktop:maximize'),
  close: () => ipcRenderer.send('desktop:close'),
  isMaximized: () => ipcRenderer.invoke('desktop:is-maximized'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('desktop:set-always-on-top', flag),
  isAlwaysOnTop: () => ipcRenderer.invoke('desktop:is-always-on-top'),
  toggleMiniPlayer: () => ipcRenderer.invoke('desktop:toggle-mini-player'),
  isMiniPlayer: () => ipcRenderer.invoke('desktop:is-mini-player'),
  setKeepScreenOn: (on) => ipcRenderer.send('desktop:set-keep-screen-on', on),
  openExternal: (url) => ipcRenderer.send('desktop:open-external', url),
  onStateChange: (callback) => {
    ipcRenderer.on('desktop:state-changed', (_e, data) => callback(data));
  },
  /** Identify a Shazam signature from the main process. Resolves to Shazam's raw JSON. */
  shazamRecognize: (signature) => ipcRenderer.invoke('desktop:shazam-recognize', {
    uri: String(signature && signature.uri || ''),
    samplems: Number(signature && signature.samplems) || 0
  }),
  getAppVersionInfo: () => ({
    name: 'LyricWave Desktop',
    version: '1.1.0',
    platform: process.platform
  })
};

contextBridge.exposeInMainWorld('LyricWaveDesktop', desktopAPI);

// Compatibility bridge for existing Android / native app hooks
contextBridge.exposeInMainWorld('LyricWaveNative', {
  isNativeApp: true,
  platform: 'desktop',
  setKeepScreenOn: (on) => desktopAPI.setKeepScreenOn(on),
  haptic: () => {}, // Desktop doesn't have haptic motors
  setChromeColor: () => {},
  getAppVersionInfo: () => JSON.stringify(desktopAPI.getAppVersionInfo()),
  // Media sessions ("Now Playing" source): same contract as the Android shell.
  hasMediaAccess: () => {
    const snap = currentNowPlaying();
    return Boolean(snap.access);
  },
  getNowPlaying: () => JSON.stringify(currentNowPlaying()),
  openMediaAccessSettings: () => {},
  mediaControl: (action, positionMs) => { ipcRenderer.invoke('desktop:media-control', action, positionMs).catch(() => {}); },
  stopNowPlaying: () => ipcRenderer.send('desktop:now-playing-stop')
});

// Inject Desktop Enhancements on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('is-desktop');
  document.documentElement.setAttribute('data-desktop-platform', process.platform);

  // Inject desktop styles
  const style = document.createElement('style');
  style.id = 'desktop-custom-styles';
  style.textContent = `
    /* Draggable window header */
    .brand-header-row {
      -webkit-app-region: drag;
      padding-top: ${process.platform === 'darwin' ? '28px' : '6px'};
      user-select: none;
    }

    /* Interactive header elements must be no-drag */
    .brand-left, .brand-actions, .brand-actions button, .source-nav, .source-tab {
      -webkit-app-region: no-drag;
    }

    /* Desktop Window Control Buttons */
    .desktop-window-controls {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
      -webkit-app-region: no-drag;
    }

    .btn-win-ctrl {
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      color: #ffffff;
      cursor: pointer;
      font-size: 13px;
      transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
    }

    .btn-win-ctrl:hover {
      background: rgba(172, 88, 233, 0.25);
      border-color: rgba(172, 88, 233, 0.5);
      color: #ffffff;
    }

    .btn-win-ctrl.active {
      background: #ac58e9;
      color: #ffffff;
      border-color: #ac58e9;
    }

    .btn-win-close:hover {
      background: #ef4444 !important;
      border-color: #ef4444 !important;
      color: #ffffff !important;
    }

    /* Mini-Player Mode Styling */
    body.is-mini-player {
      background: #000000 !important;
      overflow: hidden !important;
    }

    body.is-mini-player .container {
      padding: 6px 12px !important;
      max-width: 100% !important;
    }

    body.is-mini-player .brand-subtitle,
    body.is-mini-player .source-nav,
    body.is-mini-player .stats-cards,
    body.is-mini-player .genius-charts-section,
    body.is-mini-player .genius-news-section,
    body.is-mini-player .lyrics-viewport,
    body.is-mini-player .site-footer,
    body.is-mini-player #offlineBanner,
    body.is-mini-player #tapLineBanner,
    body.is-mini-player .btn-header-tool {
      display: none !important;
    }

    body.is-mini-player .brand-header-row {
      margin-bottom: 2px !important;
      padding-top: 0 !important;
    }

    body.is-mini-player .brand-title {
      font-size: 1rem !important;
    }

    body.is-mini-player .brand-icon {
      width: 24px !important;
      height: 24px !important;
    }

    body.is-mini-player .reel-box {
      min-height: 80px !important;
      padding: 6px 12px !important;
      margin: 4px 0 !important;
      -webkit-app-region: drag;
    }

    body.is-mini-player .reel-line-text {
      font-size: 1.1rem !important;
      line-height: 1.25 !important;
    }

    body.is-mini-player .reel-prev-line,
    body.is-mini-player .reel-next-line {
      display: none !important;
    }

    body.is-mini-player .reel-stage {
      height: 90px !important;
      min-height: 90px !important;
    }
  `;
  document.head.appendChild(style);

  // Append window controls into brand actions
  const brandActions = document.querySelector('.brand-actions');
  if (brandActions) {
    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'desktop-window-controls';

    // 1. Always on Top / Pin button
    const btnPin = document.createElement('button');
    btnPin.type = 'button';
    btnPin.className = 'btn-win-ctrl';
    btnPin.title = 'Always on Top (Ctrl+Shift+T)';
    btnPin.setAttribute('aria-label', 'Toggle Always on Top');
    btnPin.innerHTML = '📌';
    btnPin.addEventListener('click', async () => {
      const isTop = await desktopAPI.isAlwaysOnTop();
      await desktopAPI.setAlwaysOnTop(!isTop);
    });

    // 2. Mini-Player button
    const btnMini = document.createElement('button');
    btnMini.type = 'button';
    btnMini.className = 'btn-win-ctrl';
    btnMini.title = 'Mini-Player Mode (Ctrl+Shift+M)';
    btnMini.setAttribute('aria-label', 'Toggle Mini-Player Mode');
    btnMini.innerHTML = '🗗';
    btnMini.addEventListener('click', async () => {
      await desktopAPI.toggleMiniPlayer();
    });

    controlsContainer.appendChild(btnPin);
    controlsContainer.appendChild(btnMini);

    // On Windows and Linux, add standard window frame controls (minimize, maximize, close)
    if (process.platform !== 'darwin') {
      const btnMin = document.createElement('button');
      btnMin.type = 'button';
      btnMin.className = 'btn-win-ctrl';
      btnMin.title = 'Minimize';
      btnMin.setAttribute('aria-label', 'Minimize Window');
      btnMin.innerHTML = '─';
      btnMin.addEventListener('click', () => desktopAPI.minimize());

      const btnMax = document.createElement('button');
      btnMax.type = 'button';
      btnMax.className = 'btn-win-ctrl btn-win-max';
      btnMax.title = 'Maximize';
      btnMax.setAttribute('aria-label', 'Maximize or Restore Window');
      btnMax.innerHTML = '□';
      btnMax.addEventListener('click', () => desktopAPI.maximize());

      const btnClose = document.createElement('button');
      btnClose.type = 'button';
      btnClose.className = 'btn-win-ctrl btn-win-close';
      btnClose.title = 'Close';
      btnClose.setAttribute('aria-label', 'Close Window');
      btnClose.innerHTML = '✕';
      btnClose.addEventListener('click', () => desktopAPI.close());

      controlsContainer.appendChild(btnMin);
      controlsContainer.appendChild(btnMax);
      controlsContainer.appendChild(btnClose);
    }

    brandActions.appendChild(controlsContainer);

    // Listen for state changes from main process
    desktopAPI.onStateChange((state) => {
      btnPin.classList.toggle('active', Boolean(state.isAlwaysOnTop));
      btnMini.classList.toggle('active', Boolean(state.isMiniPlayer));

      const btnMax = controlsContainer.querySelector('.btn-win-max');
      if (btnMax) {
        btnMax.innerHTML = state.isMaximized ? '❐' : '□';
        btnMax.title = state.isMaximized ? 'Restore Down' : 'Maximize';
      }

      document.body.classList.toggle('is-mini-player', Boolean(state.isMiniPlayer));
    });

    // Check initial state
    desktopAPI.isAlwaysOnTop().then((top) => btnPin.classList.toggle('active', Boolean(top)));
  }
});
