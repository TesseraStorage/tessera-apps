# TODO — Tessera Apps: Status & Next Steps

## Current status (2026-09-06) — ALL FEATURES WORKING

### ✅ Web app (verified with Selenium + curl, 15/15 tests passing)

| Feature | Status | Notes |
|---------|--------|-------|
| WASM init + page load | ✅ | |
| Connect to indexer | ✅ | Via proxy :3099 |
| List files | ✅ | Relay endpoint or WASM SDK fallback |
| Upload | ✅ | Via relay /__sia__/upload (native SDK backend) |
| Download | ✅ | Via relay /__sia__/download/:id |
| Share | ✅ | WASM SDK (indexer-only, no host needed) |
| Delete | ✅ | Relay or WASM SDK fallback |
| Logout | ✅ | |

### ✅ Desktop app (Electron + native NAPI SDK)

Same feature set. Desktop uses `@siafoundation/sia-storage` via IPC for
upload/download, and WASM SDK for indexer communication.  Native file
dialogs for pick/save.

### 🌐 How upload/download works

The browser cannot reach siamux hosts directly.  Files are proxied through
the relay on :3099 using raw binary POST/GET with query param metadata.
The proxy uses the native NAPI SDK for actual host communication.

### How to run

**Web:** `npm run dev:web`
**Desktop:** `npm run dev:desktop`
**Production web:** `npm run build:web && npm run prod:web`

### Key files

- `packages/shared/src/files.js` — dual-mode upload/download (desktop IPC / web relay)
- `packages/proxy/index.js` — CORS proxy + /__sia__/* relay endpoints
- `apps/desktop/electron/sia-bridge.mjs` — native SDK wrapper for desktop
- `apps/desktop/electron/main.js` — Electron main process (IPC + proxy)
- `packages/shared/src/interceptor.js` — fetch interceptor + WebTransport shim