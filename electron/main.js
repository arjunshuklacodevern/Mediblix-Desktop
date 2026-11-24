/**
 * Mediblix Desktop — Electron Main Process
 *
 * Manages application lifecycle, creates windows for both portals,
 * and provides a secure IPC bridge to the renderer processes.
 */

const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const url = require('url');

// ─── Environment ──────────────────────────────────────────────────────────────
const IS_DEV = !app.isPackaged && !process.argv.includes('--production');
const FRONTEND_DEV_URL = 'http://localhost:5173';
const ADMIN_DEV_URL    = 'http://localhost:5174';

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

// ─── Database path (for future SQLite integration) ───────────────────────────
const DB_PATH = path.join(app.getPath('userData'), 'mediblix.db');

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

// ─── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createAppMenu();
  setupIPC();
  createPortalWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPortalWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
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
