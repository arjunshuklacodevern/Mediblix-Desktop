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
  checkBackendHealth,
  resolveNodeRuntime,
  isSpawnedByElectron,
  getBackendChild
} = require('./backend-supervisor');
// Packaged apps ship `database/` outside app.asar (it is an extra resource).
const dbPaths = app.isPackaged
  ? require(path.join(process.resourcesPath, 'database', 'paths.js'))
  : require('../database/paths');
const { getCanonicalDbPath, getInitialCredentialsPath } = dbPaths;
const { createLocalAISupervisor } = require('./local-ai-supervisor');
const { createAIControlServer } = require('./ai-control-server');
const { getHardwareProfile } = require('./hardware-profile');
const { resolveTier } = require('./ai-catalog');
const {
  parseCredentials,
  shouldNotify,
  archiveCredentialsFile
} = require('./first-run-notice');

// ─── Environment ──────────────────────────────────────────────────────────────
const IS_DEV = !app.isPackaged && !process.argv.includes('--production');
const FRONTEND_DEV_URL = 'http://localhost:5173';
const ADMIN_DEV_URL    = 'http://localhost:5174';

// ─── Canonical Database Path (%APPDATA%/Mediblix/mediblix.db) ─────────────────
const DB_PATH = getCanonicalDbPath();

let isQuitting = false;
let localAI = null;
let aiControl = null;

// ─── Backend Process Management ─────────────────────────────────────────────
async function startBackend(extraEnv = {}) {
  const backendScript = app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'index.js')
    : path.join(__dirname, '..', 'backend', 'index.js');

  const backendCwd = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend');

  // Packaged builds run the backend on Electron's embedded Node when no
  // separate node binary is bundled, so no system Node.js is required.
  const nodeRuntime = resolveNodeRuntime(app.isPackaged ? process.resourcesPath : null);

  return supervisorStartBackend({
    port: Number(process.env.PORT) || DEFAULT_PORT,
    backendScript,
    backendCwd,
    nodeBin: nodeRuntime.bin,
    nodeEnv: nodeRuntime.env,
    isDev: IS_DEV,
    env: extraEnv
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

  // Local AI runtime health (read-only; no shell access is exposed)
  ipcMain.handle('localai:status', async () => {
    if (!localAI) return { available: false, reason: 'not-initialized' };
    return localAI.status({ probeNow: true });
  });

  ipcMain.handle('localai:ensure', async (_event, kind = 'text') => {
    if (!localAI) return { ok: false, reason: 'not-initialized' };
    return localAI.ensureModel(kind === 'vision' ? 'vision' : 'text');
  });

  ipcMain.handle('localai:unload', async (_event, kind = 'vision') => {
    if (!localAI) return { unloaded: false, reason: 'not-initialized' };
    return localAI.unloadModel(kind === 'vision' ? 'vision' : 'text');
  });

  ipcMain.handle('localai:stop', async () => {
    if (!localAI) return { stopped: false, reason: 'not-initialized' };
    return localAI.stopAll();
  });

  // Open external links
  ipcMain.on('shell:open-external', (event, url) => {
    shell.openExternal(url);
  });
}

let firstRunNoticeHandled = false;

/**
 * Shows the initial-administrator credentials exactly once, and only when the
 * running backend process actually provisioned the superadmin.
 *
 * Ordinary launches, backend restarts, health polling and dialog dismissal can
 * never replay it: the provisioning flag is per-backend-process, an in-memory
 * guard covers the current app run, and the file is archived after display.
 */
async function notifyFirstRunCredentials() {
  try {
    if (firstRunNoticeHandled) return;

    const health = await checkBackendHealth(Number(process.env.PORT) || DEFAULT_PORT, null);
    if (!health.isHealthy || !health.provisionedAdmin) return;

    const credPath = getInitialCredentialsPath();
    if (!fs.existsSync(credPath)) return;

    const credentials = parseCredentials(fs.readFileSync(credPath, 'utf8'));
    if (!shouldNotify({ provisionedAdmin: true, credentials, alreadyHandled: firstRunNoticeHandled })) {
      return;
    }

    dialog.showMessageBoxSync({
      type: 'info',
      title: 'Mediblix — Administrator Account',
      message: 'Initial Administrator Account Generated',
      detail: [
        'A unique administrator account has been created for your installation:\n',
        `Email:    ${credentials.email}`,
        `Password: ${credentials.password}\n`,
        `These credentials are saved at:\n${credPath}\n`,
        'Please log in to the Super Admin portal and update your password.'
      ].join('\n'),
      buttons: ['OK']
    });

    // Marked handled before archiving: a displayed dialog must never repeat,
    // even if the archive step below fails.
    firstRunNoticeHandled = true;

    const archive = archiveCredentialsFile(credPath);
    if (archive.archived) {
      console.log('[Electron] First-run credentials archived:', archive.path);
    } else {
      console.warn('[Electron] Could not archive first-run credentials:', archive.error);
    }
  } catch (err) {
    // The credentials file is left untouched, so they are not lost.
    console.error('[Electron] Credential notification error:', err.message);
  }
}

// ─── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createAppMenu();
  setupIPC();

  try {
    // The local AI runtime is created before the backend, because the backend
    // needs its control channel to load models on demand. Nothing here blocks
    // the UI: no model is started until a feature actually needs one.
    const catalog = require('./ai-model-catalog.json');
    const hardware = getHardwareProfile({
      requestedTier: process.env.MEDIBLIX_AI_TIER || null,
      availableTiers: Object.keys(catalog.tiers || {}),
    });
    const activeTier = resolveTier(catalog, hardware.tier);

    localAI = createLocalAISupervisor({
      catalog,
      appDataDir: app.getPath('userData'),
      resourcesPath: app.isPackaged ? process.resourcesPath : null,
      devRoot: app.isPackaged ? null : path.join(__dirname, '..'),
      env: { ...process.env },
      hardware,
      tier: activeTier.id,
    });

    // One line of startup evidence that the packaged runtime and the models in
    // user data are both visible, without spawning a model.
    localAI
      .status()
      .then((aiStatus) => {
        console.log(
          `[Electron] Local AI: runtime=${
            aiStatus.runtime.installed ? aiStatus.runtime.path : "MISSING"
          } models=${aiStatus.modelDir} ready(chat=${aiStatus.ready.chat}, vision=${aiStatus.ready.vision}) tier=${aiStatus.tier?.id}`
        );
      })
      .catch((error) => console.warn(`[Electron] Local AI status failed: ${error.message}`));

    aiControl = createAIControlServer({ supervisor: localAI });
    const control = await aiControl.listen();

    console.log(
      `[Electron] Hardware: ${hardware.cpuCount} cores, ${hardware.totalMemGb} GB RAM, ${hardware.platformKey} — AI tier "${activeTier.id}"`
    );
    for (const warning of hardware.warnings || []) {
      console.warn(`[Electron] ${warning}`);
    }

    await startBackend({
      MEDIBLIX_AI_CONTROL_URL: control.url,
      MEDIBLIX_AI_CONTROL_TOKEN: control.token,
      MEDIBLIX_MODEL_DIR: localAI.modelDir,
      MEDIBLIX_MODEL_CATALOG: path.join(__dirname, 'ai-model-catalog.json'),
      MEDIBLIX_AI_TIER: activeTier.id || '',
      MEDIBLIX_AI_HARDWARE: JSON.stringify(hardware),
    });

    localAI
      .status()
      .then((status) => {
        const ready = status.ready || {};
        console.log(
          `[Electron] Local AI models: chat=${Boolean(ready.chat)} document=${Boolean(ready.document)} vision=${Boolean(ready.vision)} setupRequired=${Boolean(status.setupRequired)}`
        );
      })
      .catch((error) => console.warn('[Electron] Local AI status error:', error.message));

    await notifyFirstRunCredentials();

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
  if (localAI) {
    try {
      await localAI.stopAll();
    } catch {}
  }
  if (aiControl) {
    try {
      await aiControl.close();
    } catch {}
  }
  await stopBackend();
  app.quit();
});

app.on('before-quit', async (e) => {
  if (isQuitting) return;

  const ownsBackend = Boolean(getBackendChild() && isSpawnedByElectron());
  const ownsLocalAI = Boolean(
    localAI && Object.values(localAI.getOwnership()).some((slot) => slot.startedByUs)
  );

  if (!ownsBackend && !ownsLocalAI) return;

  e.preventDefault();
  isQuitting = true;
  console.log('[Electron] before-quit: releasing owned services...');

  // Only stop the local AI runtimes this application started.
  if (ownsLocalAI) {
    try {
      await localAI.stopAll();
    } catch (error) {
      console.warn('[Electron] Local AI shutdown error:', error.message);
    }
  }

  if (aiControl) {
    try {
      await aiControl.close();
    } catch (error) {
      console.warn('[Electron] Local AI control shutdown error:', error.message);
    }
  }

  await stopBackend();
  app.quit();
});

app.on('will-quit', async () => {
  if (localAI) {
    try {
      await localAI.stopAll();
    } catch {}
  }
  if (aiControl) {
    try {
      await aiControl.close();
    } catch {}
  }
  await stopBackend();
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
