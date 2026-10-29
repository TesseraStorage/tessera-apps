# Tessera

**Decentralized, encrypted file storage on the [Sia network](https://sia.tech).**

Tessera stores your files encrypted, erasure-coded, and spread across ~30 independent
hosts — no single point of failure, and only you hold the keys. It ships as a **web app**
and a **cross-platform desktop app** (macOS, Windows, Linux).

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
  - [Web app (development)](#web-app-development)
  - [Web app (production)](#web-app-production)
  - [Desktop app (development)](#desktop-app-development)
- [Using the app](#using-the-app)
  - [Connecting an account](#connecting-an-account)
  - [Recovery phrase](#recovery-phrase)
  - [Recovering an existing account](#recovering-an-existing-account)
  - [Upload, download, share, delete](#upload-download-share-delete)
- [Account linking, billing, and egress](#account-linking-billing-and-egress)
  - [One-time handoff (Tessera Web)](#one-time-handoff-tessera-web)
  - [Billing views](#billing-views)
  - [Egress reporting](#egress-reporting)
- [Installing the desktop app](#installing-the-desktop-app)
- [Building release artifacts](#building-release-artifacts)
- [Testing](#testing)
- [Continuous integration](#continuous-integration)
- [Environment variables](#environment-variables)

---

## Features

- **End-to-end encryption** — files are encrypted client-side before leaving your device.
- **Erasure coding** — data is split into 10 data shards + 20 parity shards, so files
  survive many simultaneous host failures.
- **Distributed storage** — spread across ~30 independent hosts on the Sia network.
- **Share links** — generate time-limited links to share individual files.
- **Account recovery** — a 12-word BIP-39 recovery phrase restores your account on any device.
- **Web + desktop** — same UI and shared codebase for both targets.

---

## Architecture

```
Browser / Electron renderer
  ├── Indexer requests (HTTP)  →  fetch interceptor → CORS proxy (:3099) → index.dithr.dev
  └── Host communication (upload/download)
        ├── Web:  raw binary POST/GET relayed through the proxy (:3099) to the native SDK
        └── Desktop: native NAPI SDK via Electron IPC (raw TCP to hosts)
```

The browser cannot reach Sia hosts directly (they speak raw `siamux` over TCP, not
QUIC/WebTransport), so **file bytes are relayed through the local proxy on port `3099`**,
which uses the native `@siafoundation/sia-storage` SDK for real host communication. The
desktop app ships the native SDK inside Electron and talks to hosts directly.

---

## Repository layout

| Path | Role |
|------|------|
| `packages/shared/` | Shared UI, store, auth, SDK wrapper, file operations, the handoff and billing modules, and egress reporting used by both apps |
| `packages/proxy/` | CORS proxy + `/__sia__/*` relay endpoints (serves web app + proxies indexer + uploads/downloads via native SDK) |
| `apps/web/` | Web app (Vite SPA) |
| `apps/desktop/` | Electron desktop app |
| `scripts/start-dev.js` | Launches the proxy + Vite (+ Electron for desktop) together |

---

## Prerequisites

- **Node.js 20+** (CI uses Node 20)
- **npm** (workspaces are used — a single `npm install` at the root installs everything)

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/TesseraStorage/tessera-apps.git
cd tessera-apps

# 2. Install dependencies (monorepo workspaces)
npm install
```

### Web app (development)

```bash
npm run dev:web
```

This starts two processes:

| Process | URL | Purpose |
|---------|-----|---------|
| CORS proxy + relay | `http://localhost:3099` | Proxies indexer requests and relays file uploads/downloads |
| Vite dev server | `http://localhost:5173` | Hot-reloading web app |

Open **http://localhost:5173** in your browser.

### Web app (production)

```bash
# Build the web bundle
npm run build:web

# Serve the built app through the proxy on :3099
npm run prod:web
```

Then open **http://localhost:3099**.

> **Why the proxy is required:** the browser can't reach the Sia network directly. The
> proxy (port `3099`) handles indexer CORS and relays raw file bytes to hosts via the
> native SDK. Without it running, upload/download won't work in the browser.

> **Proxy service-account key:** `packages/proxy/index.js` funds host operations with an
> indexd service account. Its 64-hex seed is not in the repo — set
> `TESSERA_PROXY_SERVICE_APP_KEY` in the proxy environment (the proxy fails fast with a
> clear error when it is missing or malformed). A previous value was committed to this
> repository's history; it was **revoked on 2026-10-11** (service account soft-deleted
> and its connect key revoked) and must never be used.

### Desktop app (development)

```bash
npm run dev:desktop
```

Launches the proxy + Vite + Electron together. The desktop app uses the native SDK over
IPC for upload/download and native file dialogs for picking and saving files.

---

## Using the app

### Connecting an account

1. Click **Connect**.
2. An approval link appears — click it to open the approval page in a new tab.
3. Enter your **connect key** and click **Accept**.
4. Close the approval tab and return to the app — it detects approval automatically.

### Recovery phrase

After approval, the app shows a **12-word recovery phrase**. This is the **only** way to
recover your account — write it down or store it in a password manager. You can also
optionally encrypt and save it locally with a master password.

Click **"I have saved them"** to finish registration and reach the file screen.

### Recovering an existing account

If you clear your browser data, switch devices, or log out, your local credentials are
gone. To restore your account:

1. On the connect screen, click **"Recover existing account"**.
2. Enter your 12-word recovery phrase.
3. Click **"Recover my account"**.

The app validates the phrase, re-derives your key, and (if needed) walks you through the
approval flow again before returning you to your files.

### Upload, download, share, delete

- **Upload** — drag & drop files onto the dropzone, or click to browse.
- **Download** — select a file and click **Download**.
- **Share** — select a file and click **Share** to generate a link valid for 30 days.
- **Delete** — select a file and click **Delete** (this unpins it from Sia).

---

## Account linking, billing, and egress

Tessera Web and the desktop app share the same handoff, billing, and SDK code
from `packages/shared`.

### One-time handoff (Tessera Web)

From `/account` on tessera.storage, **Connect this device** mints a one-time
code (`POST /api/v1/handoff/mint`, session cookie only) and redirects to
`https://tessera.storage/web/#handoff=<code>`. The code travels only in the URL
fragment — never a query string — so it is not sent to the server, and the web
shell consumes it with `POST /handoff/consume` (single use, 300 s TTL).
`packages/shared/src/handoff.js` owns the client flow:

- `200` → the returned `connectKey` is kept in a same-tab `sessionStorage`
  marker and registration resumes from it on reload (the code is never
  re-consumed);
- `409` → recovery screen (no local identity) or already-linked no-op;
- `410` → "link expired"; mint a new link from `/account`;
- if the device already holds an identity, the flow first asks for explicit
  confirmation before consuming.

Handoff codes and connect keys are never logged, persisted outside the same-tab
marker, or placed in a URL query. Legacy `?handoff=` links are re-written to
the fragment immediately, but the initial request that carried the query
remains loggable server-side — use fragment links.

### Transfer readiness (new accounts)

A new account gets a free $0.05 credit for its first upload; the server funds
the storage hosts a few seconds after the client first asks for hosts. Until
that lands, the SDK reports a host shortage. `packages/shared/src/readiness.js`
(`withTransferReadiness`) wraps uploads and downloads on web, desktop and Drop:
on a host-shortage error it shows "Waiting for your account to be ready…" and
retries every 5 s for up to 120 s. The raw "no more hosts available" error is
never shown; instead the user sees one of:

- insufficient balance (balance still $0 after 30 s): top up — from $0.01
  with an x402 wallet, from about $0.38 by crypto checkout;
- not enough storage hosts reachable from this network (balance is funded but
  the shortage persists): each upload needs 30 hosts reachable over TCP,
  each download 10;
- account not ready yet (balance unknown): try again shortly.

Transfers are not gated on the account `Ready` flag, so a free account that is
still paused (`born_paused`) can make its first upload without waiting forever.
The CLI (v1.10.0+) does the same check up front and can also count reachable
hosts.

### Billing views

`packages/shared/src/billing.js` is the account view: balance, plan, period
end, days left, open slabs, egress usage/allowance, warnings, and
`status`/`kind`/`topup_url`. On the web it fetches same-origin `/api/v1` with
the ambient `tessera_session` cookie; the top-up form renders only when the
NOWPayments rail is open (`topup_rails.nowpayments`, falling back to
`topup_open` on an older API). Top-ups are open on production via NOWPayments
and x402.

**Top-up minimums (v0.8.0).** The form defaults to **$5.00**. The absolute
floor is $0.01, but only the x402 rail (USDC on Base, paid from a wallet —
`tessera wallet init` then `tessera topup <usd> --wallet`) goes that low.
Crypto checkout (NOWPayments) accepts many coins — USDC on Base, LTC, TRX,
SOL, ETH, BTC, XMR, USDT, … — each with its own live minimum (about $0.38
for USDC on Base, ~$1.60 for BTC, ~$7 for XMR at the time of writing). The
web form loads the live per-coin minimums from `GET /billing/topup/minimums`;
below the cheapest coin's minimum it shows an inline warning with the real
minimum and the x402 alternative, and disables the button. The server
enforces the same rule (`409 below_asset_minimum`). Invoice and address
expiry times are shown in your local time zone. On desktop the
module never calls `fetch`: it reads account data through
`window.tesseraDesktop.billingAccount()`, implemented in
`apps/desktop/electron/` by `cli-bridge.mjs` (IPC `tessera-billing-account`,
preload bridge) from the bundled CLI's `tessera account --json`. Bridge errors
map to `no_credentials` (the "run `tessera login`" empty state),
`desktop_bridge_unavailable`, `desktop_bridge_error`, and `account_unavailable`
(retryable, not a login prompt). Top-up creation is web-only
(`desktop_topup_unsupported`).

**CLI dependency:** desktop account data requires a bundled `tessera-cli` that
supports `account`. The pinned default (`TESSERA_CLI_VERSION`, currently
`v1.11.1`, checked against the release's SHA256SUMS) includes it, so a release build feeds the balance panel from the
bundled CLI; with no billing credential it shows the "run `tessera login`"
empty state. For local
development/testing you can bundle a locally built binary with the
build-time-only override:

```bash
TESSERA_CLI_PATH=/path/to/tessera-cli npm -w apps/desktop run fetch:cli
```

`TESSERA_CLI_PATH` is never set in CI defaults and is not read at runtime by
the packaged app; release builds always take the pinned download.

### Egress reporting

Tessera Web reports served-shard egress to its own origin: `wireEgress()` in
`packages/shared/src/auth.js` calls
`builder.egressUrl(location.origin + '/api/v1/usage/egress')` (nginx → moneyd)
when the app prefix is `tesseraweb`, the fetch mode is `idx`, the page is
`http(s):`, and it is neither the stock door nor desktop. Desktop egress from
`file://` is deferred; the desktop and stock builds never configure it.

---

## Installing the desktop app

Download the appropriate asset from the
[latest release](https://github.com/TesseraStorage/tessera-apps/releases/latest).

### Linux

**Fedora / RHEL / CentOS:**

```bash
sudo dnf install ./Tessera-1.0.0-x86_64.rpm
```

**Debian / Ubuntu:**

```bash
sudo dpkg -i ./Tessera-1.0.0-amd64.deb
```

**Any distro (AppImage):**

```bash
chmod +x Tessera-1.0.0-x86_64.AppImage
./Tessera-1.0.0-x86_64.AppImage
```

> If the AppImage reports `dlopen(): error loading libfuse.so.2`, either install FUSE
> (`sudo dnf install fuse` / `sudo apt install libfuse2`) or use the `.rpm`/`.deb` package
> instead.

### macOS

Open `Tessera-1.0.0-arm64.dmg` (Apple Silicon) or `Tessera-1.0.0-x64.dmg` (Intel) and drag
Tessera into Applications.

### Windows

Run `Tessera-1.0.0-x64.exe` (NSIS installer) and follow the prompts.

---

## Building release artifacts

```bash
# Web
npm run build:web

# Desktop (per platform — run on the matching OS)
npm run package:desktop:mac      # produces Tessera-1.0.0-{arm64,x64}.dmg
npm run package:desktop:linux    # produces AppImage, .deb, and .rpm
npm run package:desktop:win      # produces Tessera-1.0.0-x64.exe
```

Desktop output lands in `apps/desktop/dist-electron/`.

---

## Testing

```bash
# Shared workspace tests: handoff, billing, views, store (node:test)
npm test

# Vendored wasm hash marker (CI runs this before building the web app)
(cd packages/shared/vendor/sia-storage && sha256sum -c VERSION)

# Builds
npm run build:web
npm run build:desktop

# Desktop CLI-bridge tests
node --test apps/desktop/test                  # Node 20 (what CI pins)
node --test apps/desktop/test/*.test.mjs       # Node >= 23 (glob, not a directory)

# Local E2E: handoff + billing against scratch DBs and a stub indexer
python3 test/e2e/e2e_handoff_billing.py
```

The desktop bridge tests are hermetic and portable: stub-binary mapping tests
skip on Windows (POSIX shebang), and the real-binary integration test skips
unless the bundled CLI advertises `account`.

---

## Continuous integration

`.github/workflows/build.yml` builds on every push/PR and creates a GitHub Release on tag
pushes (`v*`).

**Release jobs:**

| Job | Artifacts |
|-----|-----------|
| `build-web` | `tessera-web` (static site) |
| `build-desktop` (ubuntu) | `.AppImage`, `.deb`, `.rpm` |
| `build-desktop` (macos-latest) | `.dmg` (arm64) |
| `build-desktop` (macos-26-intel) | `.dmg` (x64) |
| `build-desktop` (windows) | `.exe` (NSIS) |

Cutting a release:

```bash
git tag v0.0.x
git push origin v0.0.x
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `TESSERA_PORT` | `3099` | Proxy/relay port |
| `VITE_DEV_SERVER_URL` | — | Set by `start-dev.js` so Electron loads the Vite dev server |
| `TESSERA_CLI_VERSION` | `v1.6.1` | Pinned `tessera-cli` release downloaded by `fetch:cli` and bundled into the desktop app |
| `TESSERA_CLI_PATH` | — | Build-time-only override: copy this local CLI binary instead of downloading a pinned release; never set in CI defaults |

---

## Indexer

Tessera connects to the indexer at `https://index.tessera.storage`. The SDK derives an
`AppKey` from your recovery phrase and uses it to authenticate with the indexer and the
Sia hosts.


## Desktop updates (v0.8.0)

The desktop app checks the latest
[tessera-apps release](https://github.com/TesseraStorage/tessera-apps/releases/latest)
about 15 s after launch and then every 24 h. When a newer version exists it
shows a native notification (once per version) and a banner with
**Download & install**. The app downloads the installer for your platform
(`.dmg`, `.exe`, `.AppImage`, `.deb` or `.rpm`), verifies it against the
release's `SHA256SUMS`, and then either replaces itself and restarts
(AppImage) or opens the verified installer. A checksum mismatch discards the
download and offers the release page instead. Nothing is downloaded until you
click. **Don't check again** in the banner, or `TESSERA_NO_UPDATE_CHECK=1`,
turns the check off. Logic: `apps/desktop/electron/updater.mjs`
(tests: `apps/desktop/test/updater.test.mjs`).

## Account recovery and deletion

Your recovery phrase is the account: `tessera login "<phrase>"` (CLI v1.11.0+)
restores the same account ID and App ID with no browser. Keep the phrase and
the API key the CLI prints at signup somewhere safe. To delete your account
use the website's **Account → Delete account** or `tessera account delete`.
Deletion revokes your keys, deletes your stored files, stops billing and is
permanent. Any remaining balance is forfeited — there are no refunds.
