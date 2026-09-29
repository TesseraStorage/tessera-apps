// Tessera Desktop — Electron main process
//
// Starts the CORS proxy and exposes Sia operations via IPC using the
// native @siafoundation/sia-storage SDK (NAPI addon with raw TCP access).

import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import * as cliBridge from './cli-bridge.mjs'

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

ipcMain.handle('tessera-sync-list', async () => cliBridge.syncList())
ipcMain.handle('tessera-sync-run', async (_e, rootId) => cliBridge.syncRun(rootId))
ipcMain.handle('tessera-sync-remove', async (_e, rootId) => cliBridge.syncRemove(rootId))
ipcMain.handle('tessera-sync-conflicts', async () => cliBridge.syncConflicts())
ipcMain.handle('tessera-service-status', async () => cliBridge.serviceStatus())
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