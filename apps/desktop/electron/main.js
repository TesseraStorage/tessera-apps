// Tessera Desktop — Electron main process
//
// Starts the CORS proxy and exposes Sia operations via IPC using the
// native @siafoundation/sia-storage SDK (NAPI addon with raw TCP access).

import { app, BrowserWindow, ipcMain, dialog, net, safeStorage, shell, Notification } from 'electron'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import * as cliBridge from './cli-bridge.mjs'
import * as updater from './updater.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

let mainWindow = null
let proxyProcess = null
let siaBridge = null

// ---- proxy --------------------------------------------------

function startProxy() {
  return new Promise((resolve) => {
    // Check if proxy is already running by making an actual HTTP request
    const req = http.get('http://127.0.0.1:3099/', (res) => {
      res.resume()
      console.log('[main] proxy already running on :3099 (status ' + res.statusCode + ')')
      resolve()
    })
    req.on('error', () => {
      // Port free or not responding — start our own.
      // FIX (2026-09-29): two bugs found live on a packaged macOS build.
      // (1) This relative path assumed the monorepo layout (apps/desktop/electron
      //     -> ../../../packages/proxy), which only exists in dev. A packaged app's
      //     __dirname is inside app.asar / Resources -- going up 3 dirs landed on
      //     Contents/packages/proxy/index.js, which was never bundled there at all,
      //     so the proxy child process crashed with MODULE_NOT_FOUND on every launch.
      //     Fix: bundle packages/proxy via electron-builder's extraResources (see
      //     apps/desktop/package.json) and resolve from process.resourcesPath when
      //     packaged.
      // (2) Spawned the SYSTEM 'node' binary, which isn't guaranteed to exist on an
      //     end-user machine (Electron bundles its own Node but doesn't put it on
      //     PATH as 'node'). Fix: spawn Electron's own binary with
      //     ELECTRON_RUN_AS_NODE=1, which makes it behave as a plain Node runtime.
      const proxyPath = app.isPackaged
        ? path.join(process.resourcesPath, 'proxy', 'index.js')
        : path.join(__dirname, '..', '..', '..', 'packages', 'proxy', 'index.js')
      proxyProcess = spawn(process.execPath, [proxyPath], {
        stdio: 'pipe',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })

      let started = false
      proxyProcess.stderr.on('data', (d) => {
        const s = d.toString()
        process.stderr.write('[proxy] ' + s)
        if (!started && s.includes('http://localhost')) { started = true; resolve() }
      })
      proxyProcess.on('error', (e) => { console.error('[main] proxy spawn error:', e.message); resolve() })
      proxyProcess.on('exit', (code) => {
        if (!started) { console.error('[main] proxy exited with code ' + code); resolve() }
      })

      setTimeout(() => { if (!started) resolve() }, 3000)
    })
    req.setTimeout(2000, () => { req.destroy(); resolve() })
  })
}

// ---- window -------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940, height: 700, minWidth: 500, minHeight: 400,
    title: 'Tessera', backgroundColor: '#080c12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
    show: false,
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Any target="_blank" link (e.g. the recovery approval link) opens in
  // the user's real system browser, not a chromeless Electron window --
  // this is what makes "open this link, approve, come back" behave
  // exactly like the CLI's own "a browser tab will open" step, without
  // needing a second in-app tab of our own.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

// ---- IPC: file dialogs --------------------------------------

// ── Updater (v0.8.0) ─────────────────────────────────────
// Checks the latest tessera-apps release at startup and once a day. A newer
// version raises one native notification per version and an in-app banner.
// "Download & install" downloads the matching installer, verifies it against
// the release's SHA256SUMS, then: AppImage — replaces itself and relaunches;
// dmg/exe/deb/rpm — opens the verified installer. Nothing is downloaded
// until the user clicks. Opt out: TESSERA_NO_UPDATE_CHECK=1 or the banner's
// "Don't check again".
let lastUpdateInfo = null

function updateStateFile() {
  return path.join(app.getPath('userData'), 'update-state.json')
}

async function runUpdateCheck() {
  const info = await updater.checkForUpdate({
    fetchFn: (url, init) => net.fetch(url, init),
    current: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    format: process.platform === 'linux' ? updater.linuxFormat() : undefined,
  })
  lastUpdateInfo = info
  return info
}

async function backgroundUpdateCheck() {
  if (process.env.TESSERA_NO_UPDATE_CHECK) return
  const state = updater.readState(updateStateFile())
  if (state.disabled) return
  const info = await runUpdateCheck()
  if (!info.available) return
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tessera-update-available', info)
  if (state.notified !== info.latest && Notification.isSupported()) {
    const n = new Notification({
      title: `Tessera ${info.latest} is available`,
      body: `You have ${info.current}. Open Tessera and click Download & install.`,
    })
    n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } })
    n.show()
    updater.writeState(updateStateFile(), { ...state, notified: info.latest })
  }
}

function scheduleUpdateChecks() {
  setTimeout(() => { backgroundUpdateCheck().catch(() => {}) }, 15_000)
  setInterval(() => { backgroundUpdateCheck().catch(() => {}) }, updater.CHECK_INTERVAL_MS)
}

ipcMain.handle('tessera-update-check', async () => runUpdateCheck())

ipcMain.handle('tessera-update-disable', async () => {
  updater.writeState(updateStateFile(), { ...updater.readState(updateStateFile()), disabled: true })
  return { ok: true }
})

ipcMain.handle('tessera-update-download', async (event) => {
  const info = lastUpdateInfo && lastUpdateInfo.available ? lastUpdateInfo : await runUpdateCheck()
  if (!info.available) return { ok: false, error: 'You already have the latest version.' }
  const dest = path.join(app.getPath('userData'), 'updates')
  const r = await updater.downloadAndVerify(info, dest, {
    fetchFn: (url, init) => net.fetch(url, init),
    onProgress: (received, total) => event.sender.send('tessera-update-progress', { received, total }),
  })
  if (!r.ok) return { ...r, url: info.url }
  // AppImage: swap the running image in place (verified bytes), relaunch.
  if (process.platform === 'linux' && process.env.APPIMAGE && r.file.endsWith('.AppImage')) {
    try {
      const target = process.env.APPIMAGE
      fs.copyFileSync(r.file, target + '.new')
      fs.chmodSync(target + '.new', 0o755)
      fs.renameSync(target + '.new', target)
      setTimeout(() => { app.relaunch({ execPath: target }); app.exit(0) }, 500)
      return { ok: true, action: 'relaunch', version: info.latest, sha256: r.sha256 }
    } catch (e) {
      // fall through to opening the folder
    }
  }
  const err = await shell.openPath(r.file)
  if (err) shell.showItemInFolder(r.file)
  return { ok: true, action: 'installer', file: r.file, version: info.latest, sha256: r.sha256 }
})

ipcMain.handle('tessera-open-external', async (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url)
})

ipcMain.handle('open-file-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], title: 'Select a file to upload',
  })
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})

ipcMain.handle('save-file-dialog', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'download', title: 'Save downloaded file',
  })
  return r.canceled || !r.filePath ? null : r.filePath
})

ipcMain.handle('write-file', async (_e, filePath, buffer) => {
  fs.writeFileSync(filePath, Buffer.from(buffer))
  return true
})

ipcMain.handle('read-file', async (_e, filePath) => {
  return fs.readFileSync(filePath)
})

ipcMain.handle('safe-encrypt', async (_e, plaintext) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(plaintext, 'utf-8').toString('base64')
  }
  return safeStorage.encryptString(plaintext).toString('base64')
})

ipcMain.handle('safe-decrypt', async (_e, encryptedB64) => {
  const buf = Buffer.from(encryptedB64, 'base64')
  if (!safeStorage.isEncryptionAvailable()) return buf.toString('utf-8')
  return safeStorage.decryptString(buf)
})

// ---- IPC: Sia bridge ----------------------------------------

async function getBridge() {
  if (!siaBridge) {
    siaBridge = await import('./sia-bridge.mjs')
  }
  return siaBridge
}

ipcMain.handle('sia-connect', async (_e, appIdHex, appKeyHex) => {
  try {
    const bridge = await getBridge()
    await bridge.connect(appIdHex, appKeyHex)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sia-disconnect', async () => {
  try {
    const bridge = await getBridge()
    bridge.disconnect()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sia-account', async () => {
  try {
    const bridge = await getBridge()
    const acct = await bridge.getAccount()
    return { ok: true, ...acct }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sia-upload', async (event, fileName, fileBuffer, mimeType) => {
  try {
    const bridge = await getBridge()
    const result = await bridge.uploadFile(fileName, fileBuffer, mimeType, (progress) => {
      // FIX (2026-09-29): this callback used to not exist at all, so the
      // renderer's onUploadProgress subscription (already wired in
      // preload.cjs) never received anything but the final synthetic
      // 'done' event below -- the map had nothing to plot for the
      // entire real transfer. event.sender is the invoking webContents;
      // pushing here (mid-handler, before the promise resolves) is what
      // makes intermediate ticks actually reach the renderer.
      event.sender.send('sia-upload-progress', progress)
    })
    mainWindow.webContents.send('sia-upload-progress', { stage: 'done', percent: 100 })
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Task 0.3: one IPC call for a multi-file user action. The renderer sends
// an array of { name, mime, size, buffer } objects; the bridge opens a single
// PackedUpload and returns one result per file in the same order.
ipcMain.handle('sia-upload-packed', async (event, files) => {
  try {
    const bridge = await getBridge()
    const results = await bridge.uploadPacked(files, (progress) => {
      event.sender.send('sia-upload-progress', progress)
    })
    event.sender.send('sia-upload-progress', { stage: 'done', percent: 100 })
    return { ok: true, results }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sia-download', async (_e, objectId) => {
  try {
    const bridge = await getBridge()
    const data = await bridge.downloadFile(objectId)
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sia-list-files', async () => {
  try {
    const bridge = await getBridge()
    const files = await bridge.listFiles()
    return { ok: true, files }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sia-delete', async (_e, objectId) => {
  try {
    const bridge = await getBridge()
    await bridge.deleteFile(objectId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sia-share', async (_e, objectId) => {
  try {
    const bridge = await getBridge()
    const url = await bridge.createShareURL(objectId)
    return { ok: true, url }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ---- IPC: tessera-cli bridge (Synced Folders) ----------------

ipcMain.handle('tessera-pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a folder to keep in sync',
  })
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})

ipcMain.handle('tessera-open-path', async (_e, p) => {
  const err = await shell.openPath(p)
  return { ok: !err, error: err || undefined }
})

ipcMain.handle('tessera-sync-add', async (_e, localPath, remotePrefix) => {
  const result = await cliBridge.syncAdd(localPath, remotePrefix)
  if (result.ok) {
    // "Installing the watcher should be automatic once a new synced folder
    // is added" — ensure the OS-native watcher is running, no separate step.
    try { await cliBridge.ensureWatcherInstalled() } catch (_) {}
  }
  return result
})

ipcMain.handle('tessera-billing-account', async () => cliBridge.account())
ipcMain.handle('tessera-sync-list', async () => cliBridge.syncList())
ipcMain.handle('tessera-sync-status', async () => cliBridge.syncStatus())
ipcMain.handle('tessera-sync-run', async (_e, rootId) => cliBridge.syncRun(rootId))
ipcMain.handle('tessera-sync-remove', async (_e, rootId) => cliBridge.syncRemove(rootId))
ipcMain.handle('tessera-sync-conflicts', async () => cliBridge.syncConflicts())
ipcMain.handle('tessera-service-status', async () => cliBridge.serviceStatus())
ipcMain.handle('tessera-cli-config', async () => cliBridge.readConfig())
// Bug 3: session-backed sign-in + recovery inside the app (no connect key,
// no approval page). Bug 6: really forget the shared device config.
ipcMain.handle('tessera-login-start', async (_e, email) => cliBridge.loginStart(email))
ipcMain.handle('tessera-login-verify', async (_e, email, token, phrase) => cliBridge.loginVerify(email, token, phrase))
ipcMain.handle('tessera-forget', async () => cliBridge.forget())
ipcMain.handle('tessera-service-install', async () => cliBridge.serviceInstall())
ipcMain.handle('tessera-service-uninstall', async () => cliBridge.serviceUninstall())
ipcMain.handle('tessera-trash-list', async () => cliBridge.trashList())
ipcMain.handle('tessera-trash-restore', async (_e, relPath) => cliBridge.trashRestore(relPath))
ipcMain.handle('tessera-versions-list', async (_e, relPath) => cliBridge.versionsList(relPath))
ipcMain.handle('tessera-versions-restore', async (_e, relPath, n) => cliBridge.versionsRestore(relPath, n))

// ---- lifecycle ---------------------------------------------

app.whenReady().then(async () => {
  try { await startProxy() } catch (e) { console.error('proxy start failed:', e) }
  createWindow()
  scheduleUpdateChecks()
})

app.on('window-all-closed', () => {
  if (proxyProcess) proxyProcess.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}