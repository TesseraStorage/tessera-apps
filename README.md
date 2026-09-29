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
- [Installing the desktop app](#installing-the-desktop-app)
- [Building release artifacts](#building-release-artifacts)
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
| `packages/shared/` | Shared UI, store, auth, SDK wrapper, and file operations used by both apps |
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

---

## Indexer

Tessera connects to the indexer at `https://index.tessera.storage`. The SDK derives an
`AppKey` from your recovery phrase and uses it to authenticate with the indexer and the
Sia hosts.
