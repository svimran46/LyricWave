const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let powerSaveId = null;
let isMiniPlayer = false;
let normalBounds = null;
let wasAlwaysOnTopBeforeMini = false;

// Window state store
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch {}
  return { width: 1100, height: 760 };
}

function saveWindowState() {
  if (!mainWindow || isMiniPlayer) return;
  try {
    const bounds = mainWindow.getBounds();
    const data = {
      ...bounds,
      isMaximized: mainWindow.isMaximized(),
      isAlwaysOnTop: mainWindow.isAlwaysOnTop()
    };
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:state-changed', {
    isMaximized: mainWindow.isMaximized(),
    isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
    isMiniPlayer,
    isFullScreen: mainWindow.isFullScreen()
  });
}

function createMainWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width || 1100,
    height: state.height || 760,
    x: state.x,
    y: state.y,
    minWidth: 420,
    minHeight: 520,
    backgroundColor: '#000000',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    show: false,
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Crucial for synchronized lyrics: don't freeze timers when window loses focus
      backgroundThrottling: false
    }
  });

  if (state.isAlwaysOnTop) {
    mainWindow.setAlwaysOnTop(true, 'floating');
  }

  // Load the web application root index.html
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (state.isMaximized && !isMiniPlayer) {
      mainWindow.maximize();
    }
    mainWindow.show();
    sendWindowState();
  });

  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.on('enter-full-screen', sendWindowState);
  mainWindow.on('leave-full-screen', sendWindowState);
  mainWindow.on('close', saveWindowState);

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle second instance invocation
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'icons', 'icon-192.png');
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    tray.setToolTip('LyricWave — Synced Lyrics Companion');

    const updateContextMenu = () => {
      const contextMenu = Menu.buildFromTemplate([
        {
          label: 'Show LyricWave',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            }
          }
        },
        {
          label: 'Always on Top',
          type: 'checkbox',
          checked: mainWindow ? mainWindow.isAlwaysOnTop() : false,
          click: (item) => {
            if (mainWindow) {
              mainWindow.setAlwaysOnTop(item.checked, 'floating');
              sendWindowState();
            }
          }
        },
        {
          label: 'Mini-Player Mode',
          type: 'checkbox',
          checked: isMiniPlayer,
          click: toggleMiniPlayer
        },
        { type: 'separator' },
        {
          label: 'Quit LyricWave',
          click: () => {
            app.isQuitting = true;
            app.quit();
          }
        }
      ]);
      tray.setContextMenu(contextMenu);
    };

    updateContextMenu();
    tray.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    if (mainWindow) {
      mainWindow.on('always-on-top-changed', updateContextMenu);
    }
  } catch (err) {
    console.warn('Tray init error:', err);
  }
}

function toggleMiniPlayer() {
  if (!mainWindow) return isMiniPlayer;
  isMiniPlayer = !isMiniPlayer;

  if (isMiniPlayer) {
    normalBounds = mainWindow.getBounds();
    wasAlwaysOnTopBeforeMini = mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setMinimumSize(360, 150);
    mainWindow.setSize(520, 185);
  } else {
    mainWindow.setMinimumSize(420, 520);
    if (normalBounds) {
      mainWindow.setBounds(normalBounds);
    } else {
      mainWindow.setSize(1100, 760);
    }
    mainWindow.setAlwaysOnTop(wasAlwaysOnTopBeforeMini, 'floating');
  }

  sendWindowState();
  return isMiniPlayer;
}

// --- IPC Handlers -----------------------------------------------------------

ipcMain.on('desktop:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('desktop:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  sendWindowState();
});

ipcMain.on('desktop:close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('desktop:is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle('desktop:set-always-on-top', (_event, flag) => {
  if (!mainWindow) return false;
  mainWindow.setAlwaysOnTop(Boolean(flag), 'floating');
  sendWindowState();
  return mainWindow.isAlwaysOnTop();
});

ipcMain.handle('desktop:is-always-on-top', () => {
  return mainWindow ? mainWindow.isAlwaysOnTop() : false;
});

ipcMain.handle('desktop:toggle-mini-player', () => {
  return toggleMiniPlayer();
});

ipcMain.handle('desktop:is-mini-player', () => isMiniPlayer);

ipcMain.on('desktop:open-external', (_event, url) => {
  if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

ipcMain.on('desktop:set-keep-screen-on', (_event, on) => {
  if (on) {
    if (powerSaveId === null || !powerSaveBlocker.isStarted(powerSaveId)) {
      powerSaveId = powerSaveBlocker.start('prevent-display-sleep');
    }
  } else {
    if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
      powerSaveBlocker.stop(powerSaveId);
      powerSaveId = null;
    }
  }
});

// App Lifecycle
app.whenReady().then(() => {
  createMainWindow();
  createTray();

  // Register Global Hotkeys
  try {
    globalShortcut.register('CommandOrControl+Shift+T', () => {
      if (mainWindow) {
        const next = !mainWindow.isAlwaysOnTop();
        mainWindow.setAlwaysOnTop(next, 'floating');
        sendWindowState();
      }
    });

    globalShortcut.register('CommandOrControl+Shift+M', () => {
      toggleMiniPlayer();
    });
  } catch (err) {
    console.warn('Global shortcut registration warning:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
