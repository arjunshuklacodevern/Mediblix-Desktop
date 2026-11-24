/**
 * Mediblix Desktop — Preload Script
 *
 * Exposes a minimal, secure API surface to the renderer processes.
 * Uses contextBridge to avoid exposing Node.js internals.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Portal selection
  openPharmacyPortal: () => ipcRenderer.send('portal:open-pharmacy'),
  openAdminPortal: () => ipcRenderer.send('portal:open-admin'),

  // App information
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),

  // Database path (for future SQLite integration)
  getDbPath: () => ipcRenderer.invoke('db:get-path'),

  // Open external links safely
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),

  // Platform info
  platform: process.platform,
  isElectron: true,
});
