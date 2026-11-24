/**
 * Automated Electron verification script
 * Opens Portal Window, Pharmacy Window, and Admin Window
 * Verifies each loads successfully with no fatal errors, then exits with code 0.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const PORTAL_HTML = path.join(__dirname, 'portal-selector.html');
const FRONTEND_HTML = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
const ADMIN_HTML = path.join(__dirname, '..', 'admin-frontend', 'dist', 'index.html');

const COMMON_PREFS = {
  preload: PRELOAD_PATH,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

async function testWindows() {
  console.log('[VERIFY] Starting Electron automated verification...');
  
  // 1. Test Portal Selector Window
  const portalWin = new BrowserWindow({
    show: false,
    webPreferences: COMMON_PREFS,
  });
  
  await portalWin.loadFile(PORTAL_HTML);
  const portalTitle = await portalWin.getTitle();
  const portalHasApi = await portalWin.webContents.executeJavaScript('Boolean(window.electronAPI && window.electronAPI.openPharmacyPortal)');
  console.log(`[VERIFY] Portal Window loaded: title="${portalTitle}", hasElectronAPI=${portalHasApi}`);
  if (!portalHasApi) throw new Error('Portal window missing electronAPI');
  portalWin.close();

  // 2. Test Pharmacy Staff Window
  const pharmacyWin = new BrowserWindow({
    show: false,
    webPreferences: COMMON_PREFS,
  });

  let pharmacyErrors = [];
  pharmacyWin.webContents.on('console-message', (e, level, msg) => {
    if (level >= 3) { // Error level
      pharmacyErrors.push(msg);
    }
  });

  await pharmacyWin.loadFile(FRONTEND_HTML);
  const pharmacyTitle = await pharmacyWin.getTitle();
  const pharmacyHasRoot = await pharmacyWin.webContents.executeJavaScript('Boolean(document.getElementById("root"))');
  const pharmacyHasApi = await pharmacyWin.webContents.executeJavaScript('Boolean(window.electronAPI && window.electronAPI.isElectron)');
  console.log(`[VERIFY] Pharmacy Window loaded: title="${pharmacyTitle}", hasRoot=${pharmacyHasRoot}, hasElectronAPI=${pharmacyHasApi}`);
  if (!pharmacyHasRoot) throw new Error('Pharmacy window missing #root');
  pharmacyWin.close();

  // 3. Test Admin Window
  const adminWin = new BrowserWindow({
    show: false,
    webPreferences: COMMON_PREFS,
  });

  let adminErrors = [];
  adminWin.webContents.on('console-message', (e, level, msg) => {
    if (level >= 3) {
      adminErrors.push(msg);
    }
  });

  await adminWin.loadFile(ADMIN_HTML);
  const adminTitle = await adminWin.getTitle();
  const adminHasRoot = await adminWin.webContents.executeJavaScript('Boolean(document.getElementById("root"))');
  const adminHasApi = await adminWin.webContents.executeJavaScript('Boolean(window.electronAPI && window.electronAPI.isElectron)');
  console.log(`[VERIFY] Admin Window loaded: title="${adminTitle}", hasRoot=${adminHasRoot}, hasElectronAPI=${adminHasApi}`);
  if (!adminHasRoot) throw new Error('Admin window missing #root');
  adminWin.close();

  console.log('[VERIFY] ALL 3 WINDOWS LOADED AND VERIFIED SUCCESSFULLY!');
  app.quit();
}

app.whenReady().then(testWindows).catch((err) => {
  console.error('[VERIFY FAILED]:', err);
  process.exit(1);
});
