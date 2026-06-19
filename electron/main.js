import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_PORT = 4173;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const isDev = process.env.NODE_ENV === 'development' || process.env.ELECTRON_IS_DEV === '1';

let mainWindow;
let serverProcess;
let tray;
let isQuitting = false;
let isListeningExternalMedia = false;
let smtcNativeModule = null;

function loadAppIcon() {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = path.join(__dirname, 'assets', iconName);
  try {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  } catch {
    // fall through to buffer fallback
  }
  try {
    const buffer = fs.readFileSync(iconPath);
    const icon = nativeImage.createFromBuffer(buffer);
    if (!icon.isEmpty()) {
      return icon;
    }
  } catch (error) {
    console.warn('Failed to load app icon:', error);
  }
  return undefined;
}

function loadSmtcNativeModule() {
  if (smtcNativeModule) return smtcNativeModule;
  if (process.platform !== 'win32') return null;

  try {
    smtcNativeModule = require('@nodert-win10/windows.media.control');
    console.log('[SMTC] Native control module loaded.');
  } catch (error) {
    console.log('[SMTC] Native control module unavailable:', error.message);
    smtcNativeModule = null;
  }

  return smtcNativeModule;
}

function sendExternalMediaInfo(info) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('external-media-info', info);
  }
}

function sendExternalMediaStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('external-media-status', status);
  }
}

function startExternalMediaListener() {
  if (isListeningExternalMedia) return;
  isListeningExternalMedia = true;

  const smtc = loadSmtcNativeModule();
  if (!smtc) {
    console.log('[SMTC] Running in stub mode; manual URL fallback is available.');
    sendExternalMediaStatus({ isPlaying: false, status: 'stub' });
    return;
  }

  // Native SMTC integration placeholder. When a Node-RT compatible module is
  // available, wire CurrentSessionChanged / MediaPropertiesChanged here and
  // call sendExternalMediaInfo / sendExternalMediaStatus.
  sendExternalMediaStatus({ isPlaying: false, status: 'active' });
}

function stopExternalMediaListener() {
  if (!isListeningExternalMedia) return;
  isListeningExternalMedia = false;
  sendExternalMediaStatus({ isPlaying: false, status: 'stopped' });
}

ipcMain.on('start-listening-external-media', startExternalMediaListener);
ipcMain.on('stop-listening-external-media', stopExternalMediaListener);

function createWindow() {
  const icon = loadAppIcon();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Sonic Topography',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(SERVER_URL);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = loadAppIcon();
  tray = new Tray(icon || nativeImage.createEmpty());
  tray.setToolTip('Sonic Topography');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Play/Pause',
      click: () => {
        mainWindow?.webContents.send('toggle-play');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function startLocalServer() {
  const serverPath = path.join(__dirname, '..', 'local-server.mjs');

  return new Promise((resolve, reject) => {
    serverProcess = fork(serverPath, [], {
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let didResolve = false;

    const markReady = (data) => {
      const text = typeof data === 'string' ? data : data.toString();
      if (text.includes(SERVER_URL) && !didResolve) {
        didResolve = true;
        resolve();
      }
    };

    serverProcess.stdout?.on('data', markReady);
    serverProcess.stderr?.on('data', markReady);

    serverProcess.on('error', (error) => {
      if (!didResolve) {
        didResolve = true;
        reject(error);
      }
    });

    serverProcess.on('exit', (code) => {
      if (!didResolve) {
        didResolve = true;
        reject(new Error(`Local server exited with code ${code}`));
      }
    });

    // Fallback: proceed after a short timeout even if the ready message was missed.
    setTimeout(() => {
      if (!didResolve) {
        didResolve = true;
        resolve();
      }
    }, 5000);
  });
}

function stopLocalServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

app.whenReady().then(async () => {
  try {
    await startLocalServer();
    createWindow();
    createTray();
  } catch (error) {
    console.error('Failed to start local server:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    stopLocalServer();
  }
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopLocalServer();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
