/**
 * Mediblix Desktop — Electron Main Process
 *
 * Manages application lifecycle, creates windows for both portals,
 * and provides a secure IPC bridge to the renderer processes.
 */

const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const {
  DEFAULT_PORT,
  startBackend: supervisorStartBackend,
  stopBackend: supervisorStopBackend,
  resolveNodeBinary,
  isSpawnedByElectron,
  getBackendChild
} = require('./backend-supervisor');
const { startOllama, stopOllama } = require('./ai-supervisor');
const { getCanonicalDbPath, getInitialCredentialsPath } = require('../database/paths');

// ─── Environment ──────────────────────────────────────────────────────────────
const IS_DEV = !app.isPackaged && !process.argv.includes('--production');
const FRONTEND_DEV_URL = 'http://localhost:5173';
const ADMIN_DEV_URL    = 'http://localhost:5174';

// ─── Canonical Database Path (%APPDATA%/Mediblix/mediblix.db) ─────────────────
const DB_PATH = getCanonicalDbPath();

let isQuitting = false;

// ─── Backend Process Management ─────────────────────────────────────────────
async function startBackend() {
  const backendScript = app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'index.js')
    : path.join(__dirname, '..', 'backend', 'index.js');

  const backendCwd = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend');

  const nodeBin = resolveNodeBinary(app.isPackaged ? process.resourcesPath : null);

  return supervisorStartBackend({
    port: DEFAULT_PORT,
    backendScript,
    backendCwd,
    nodeBin,
    isDev: IS_DEV
  });
}

function stopBackend(timeoutMs) {
  return supervisorStopBackend(timeoutMs);
}

// Paths to built frontend assets
const FRONTEND_DIST = IS_DEV
  ? null
  : path.join(
      app.isPackaged ? process.resourcesPath : __dirname,
      app.isPackaged ? 'frontend-dist' : '../frontend/dist'
    );
const ADMIN_DIST = IS_DEV
  ? null
  : path.join(
      app.isPackaged ? process.resourcesPath : __dirname,
      app.isPackaged ? 'admin-dist' : '../admin-frontend/dist'
    );

// ─── Window references ──────────────────────────────────────────────────────
let portalWindow = null;   // Portal selection window
let pharmacyWindow = null; // Pharmacy Staff portal
let adminWindow = null;    // Super Admin portal

// ─── Shared window options ──────────────────────────────────────────────────
const COMMON_WEB_PREFS = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
};

// ─── Portal Selection Window ────────────────────────────────────────────────
function createPortalWindow() {
  if (portalWindow) {
    portalWindow.focus();
    return;
  }

  portalWindow = new BrowserWindow({
    width: 600,
    height: 480,
    resizable: false,
    maximizable: false,
    title: 'Mediblix — Select Portal',
    icon: getIconPath(),
    webPreferences: COMMON_WEB_PREFS,
    show: false,
  });

  const portalHtml = path.join(__dirname, 'portal-selector.html');
  portalWindow.loadFile(portalHtml);

  portalWindow.once('ready-to-show', () => {
    portalWindow.show();
  });

  portalWindow.on('closed', () => {
    portalWindow = null;
    // If no other windows are open, quit
    if (!pharmacyWindow && !adminWindow) {
      app.quit();
    }
  });
}

// ─── Pharmacy Staff Window ──────────────────────────────────────────────────
function createPharmacyWindow() {
  if (pharmacyWindow) {
    pharmacyWindow.focus();
    return;
  }

  pharmacyWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Mediblix — Pharmacy Management',
    icon: getIconPath(),
    webPreferences: COMMON_WEB_PREFS,
    show: false,
  });

  if (IS_DEV) {
    pharmacyWindow.loadURL(FRONTEND_DEV_URL);
    pharmacyWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    pharmacyWindow.loadFile(path.join(FRONTEND_DIST, 'index.html'));
  }

  pharmacyWindow.once('ready-to-show', () => {
    pharmacyWindow.show();
  });

  pharmacyWindow.on('closed', () => {
    pharmacyWindow = null;
  });
}

// ─── Super Admin Window ────────────────────────────────────────────────────
function createAdminWindow() {
  if (adminWindow) {
    adminWindow.focus();
    return;
  }

  adminWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Mediblix — Admin Portal',
    icon: getIconPath(),
    webPreferences: COMMON_WEB_PREFS,
    show: false,
  });

  if (IS_DEV) {
    adminWindow.loadURL(ADMIN_DEV_URL);
    adminWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    adminWindow.loadFile(path.join(ADMIN_DIST, 'index.html'));
  }

  adminWindow.once('ready-to-show', () => {
    adminWindow.show();
  });

  adminWindow.on('closed', () => {
    adminWindow = null;
  });
}

// ─── Helper: get icon path ─────────────────────────────────────────────────
function getIconPath() {
  const icoPath = path.join(__dirname, '..', 'build', 'icon.ico');
  const pngPath = path.join(__dirname, 'Mediblix-logo.png');
  const fallbackPng = path.join(__dirname, '..', 'frontend', 'public', 'Mediblix-logo.png');
  try {
    require('fs').accessSync(icoPath);
    return icoPath;
  } catch {
    try {
      require('fs').accessSync(pngPath);
      return pngPath;
    } catch {
      return fallbackPng;
    }
  }
}

// ─── Application menu ──────────────────────────────────────────────────────
function createAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Portal Selector',
          click: () => createPortalWindow(),
        },
        {
          label: 'Open Pharmacy Portal',
          click: () => createPharmacyWindow(),
        },
        {
          label: 'Open Admin Portal',
          click: () => createAdminWindow(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Mediblix',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About Mediblix',
              message: 'Mediblix Desktop v1.0.0',
              detail: 'Pharmacy Management System\n© 2026 Mediblix',
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────
function setupIPC() {
  // Portal selection
  ipcMain.on('portal:open-pharmacy', () => {
    createPharmacyWindow();
    if (portalWindow) portalWindow.close();
  });

  ipcMain.on('portal:open-admin', () => {
    createAdminWindow();
    if (portalWindow) portalWindow.close();
  });

  // App info
  ipcMain.handle('app:get-info', () => ({
    version: app.getVersion(),
    name: app.getName(),
    userData: app.getPath('userData'),
    dbPath: DB_PATH,
    isDev: IS_DEV,
  }));

  // Database path (for future SQLite integration)
  ipcMain.handle('db:get-path', () => DB_PATH);

  // Open external links
  ipcMain.on('shell:open-external', (event, url) => {
    shell.openExternal(url);
  });
}

function checkAndNotifyFirstRunCredentials() {
  try {
    const credPath = getInitialCredentialsPath();
    if (fs.existsSync(credPath)) {
      const content = fs.readFileSync(credPath, 'utf8');
      const passMatch = content.match(/Password:\s*([^\r\n]+)/);
      const emailMatch = content.match(/Email:\s*([^\r\n]+)/);
      if (passMatch && emailMatch) {
        dialog.showMessageBoxSync({
          type: 'info',
          title: 'Mediblix — Administrator Account',
          message: 'Initial Administrator Account Generated',
          detail: [
            'A unique administrator account has been created for your installation:\n',
            `Email:    ${emailMatch[1]}`,
            `Password: ${passMatch[1]}\n`,
            `These credentials are saved at:\n${credPath}\n`,
            'Please log in to the Super Admin portal and update your password.'
          ].join('\n'),
          buttons: ['OK']
        });
      }
    }
  } catch (err) {
    console.error('[Electron] Credential notification error:', err.message);
  }
}

// ─── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createAppMenu();
  setupIPC();

  try {
    try {
      await startOllama({ resourcesPath: app.isPackaged ? process.resourcesPath : null });
    } catch (aiErr) {
      console.warn('[Electron] Non-blocking AI supervisor start notice:', aiErr.message);
    }

    await startBackend();
    checkAndNotifyFirstRunCredentials();

    // Register 2:00 AM nightly sync task in Windows Task Scheduler
    try {
      const { registerDailySyncTask } = require('./sync/scheduler');
      registerDailySyncTask();
    } catch (_) {}

    // Trigger non-blocking opportunistic sync in background if online
    if (app.isPackaged || process.env.MEDIBLIX_ENABLE_STARTUP_SYNC) {
      setTimeout(() => {
        try {
          const { run: runSync } = require('./sync/syncRunner');
          runSync().catch(e => console.log('[Electron] Startup sync non-blocking notice:', e.message));
        } catch (_) {}
      }, 5000);
    }

    createPortalWindow();
  } catch (err) {
    console.error('[Electron] Fatal startup error:', err);
    try {
      await stopBackend(SHUTDOWN_TIMEOUT_MS);
    } catch {}
    dialog.showErrorBox(
      'Mediblix Startup Failed',
      `${err.message || err}\n\nThe application will now close.`
    );
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPortalWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  await Promise.allSettled([stopBackend(), stopOllama()]);
  app.quit();
});

app.on('before-quit', async (e) => {
  if (isQuitting) return;
  if (getBackendChild() && isSpawnedByElectron()) {
    e.preventDefault();
    isQuitting = true;
    console.log('[Electron] before-quit: Waiting for graceful backend shutdown...');
    await Promise.allSettled([stopBackend(), stopOllama()]);
    app.quit();
  }
});

app.on('will-quit', async () => {
  await Promise.allSettled([stopBackend(), stopOllama()]);
});

// Security: Prevent new windows from being opened via links
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Allow devtools
    if (url.startsWith('devtools://')) return { action: 'allow' };
    // Open external links in default browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Prevent navigation to external sites in production
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    if (!IS_DEV && parsedUrl.origin !== 'file://') {
      event.preventDefault();
    }
  });
});
