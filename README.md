# Mediblix Desktop

Mediblix Pharmacy Management System — Windows Desktop Application built with Electron.

## Architecture

```
Mediblix-Desktop/
├── electron/                  # Electron main process
│   ├── main.js               # Application entry point & window management
│   ├── preload.js            # Secure IPC bridge (contextIsolation: true)
│   ├── runner.js             # Environment-clean Electron launcher
│   ├── portal-selector.html  # Portal selection screen
│   └── verify-runtime.js     # Automated runtime validation script
├── frontend/                 # Pharmacy Staff React app (Vite + React 19)
│   ├── dist/                 # Production compiled bundle
│   └── src/                  # React source (HashRouter for desktop file://)
├── admin-frontend/           # Super Admin React app (Vite + React 18)
│   ├── dist/                 # Production compiled bundle
│   └── src/                  # React source (HashRouter for desktop file://)
├── backend/                  # Express + MongoDB backend (reference & dev API)
├── database/                 # SQLite local-first architecture
│   ├── schema.js             # SQLite DDL schema matching all MongoDB models
│   └── MIGRATION_PLAN.md     # In-depth MongoDB-to-SQLite migration & ACID guide
├── build/                    # Build resources (256x256 icon.ico, icon.png)
├── dist-electron/            # Packaged desktop outputs
│   ├── Mediblix Setup 1.0.0.exe  # Standalone Windows NSIS installer (~92 MB)
│   └── win-unpacked/         # Portable unpacked application (Mediblix.exe)
└── package.json              # Root config with Electron & build scripts
```

## Quick Start (Development)

```bash
# 1. Install root + all frontend dependencies
npm install
npm install --prefix frontend
npm install --prefix admin-frontend

# 2. Run Electron in development mode (starts both Vite dev servers + Electron shell)
npm run dev
```

Or run dev servers individually:

```bash
# Terminal 1: Pharmacy frontend (Port 5173)
npm run dev:frontend

# Terminal 2: Admin frontend (Port 5174)
npm run dev:admin

# Terminal 3: Electron
npm run electron:dev
```

## Production Build & Packaging

```bash
# 1. Compile both frontends
npm run build:all

# 2. Launch production Electron against built bundles
npm run electron:prod

# 3. Package portable unpacked Windows application (dist-electron/win-unpacked/)
npm run pack

# 4. Generate standalone Windows NSIS installer (dist-electron/Mediblix Setup 1.0.0.exe)
npm run dist
```

## Automated Verification

```bash
# Verifies that Portal Selector, Pharmacy Staff, and Super Admin windows all load cleanly
node electron/runner.js electron/verify-runtime.js
```

## Portals Supported

1. **Pharmacy Staff Portal**
   - Inventory & stock management
   - POS billing & checkout
   - Customer tracking
   - Supplier directory & Purchase orders
   - Audits, movement logs & calendar
   - AI Import & MedAgent widgets

2. **Super Admin Portal**
   - System dashboard & stats
   - Organizations directory & onboarding
   - Account freezing, device resets & credential management
   - Subscription lifecycle tracking

## Security & Isolation

- **Context Isolation**: `contextIsolation: true` on all browser windows.
- **Node Integration**: `nodeIntegration: false` in renderers.
- **Sandboxing**: Renderer processes run in a sandbox; communication is strictly through explicit IPC channels exposed via `electronAPI` in `preload.js`.
- **Navigation Guard**: In production, external URL navigation is blocked within Electron and forwarded safely to the system's default browser via `shell.openExternal`.

## Local-First & SQLite Status

- **Schema Scaffolded**: `database/schema.js` provides full DDL matching existing MongoDB models (`organizations`, `users`, `products`, `customers`, `sales`, `sale_items`, `suppliers`, `purchase_orders`, `import_history`).
- **Migration Plan**: `database/MIGRATION_PLAN.md` documents atomic transactional sales processing, inventory decrements, and automatic daily backups (`VACUUM INTO`).
- **Current Data Mode**: Frontends currently connect to the backend API (`VITE_BACKEND_URL`). Full offline SQLite operation is staged for the subsequent phase.
