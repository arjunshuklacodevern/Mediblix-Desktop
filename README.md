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
├── backend/                  # Express + SQLite local-first API server
├── database/                 # SQLite local-first architecture
│   ├── schema.js             # SQLite DDL schema (12 tables)
│   └── MIGRATION_PLAN.md     # In-depth MongoDB-to-SQLite migration & ACID guide
├── build/                    # Build resources (256x256 icon.ico, icon.png)
├── dist-electron/            # Packaged desktop outputs
│   ├── Mediblix Setup 1.0.0.exe  # Standalone Windows NSIS installer (~92 MB)
│   └── win-unpacked/         # Portable unpacked application (Mediblix.exe)
└── package.json              # Root config with Electron & build scripts
```

## Quick Start (Development)

```bash
# 1. Install root + backend + frontend dependencies
npm install
npm install --prefix backend
npm install --prefix frontend
npm install --prefix admin-frontend

# 2. Configure frontend environment files (for dev mode)
cp frontend/.env.example frontend/.env
cp admin-frontend/.env.example admin-frontend/.env

# 3. Run Electron in development mode (starts both Vite dev servers + Electron shell)
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

- **SQLite Complete**: `database/schema.js` and `database/repositories/*` power all core workflows (products, inventory, POS billing, customers, suppliers, purchase orders, returns, import history, and admin management) completely offline.
- **Migration Plan**: `database/MIGRATION_PLAN.md` documents atomic transactional sales processing, inventory decrements, and automatic daily backups (`VACUUM INTO`).
- **MongoDB Removed**: Mongoose/MongoDB has been completely removed from `backend/`. AI inference (Gemini) is the only feature requiring internet access.
