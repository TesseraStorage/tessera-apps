// Tessera Desktop — preload script
//
// Exposes a minimal, safe bridge between renderer and main process.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tesseraDesktop', {

  // Native file picker for uploads
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),

  // Native save dialog for downloads, returns path
  saveFileDialog: (defaultName) => ipcRenderer.invoke('save-file-dialog', defaultName),

  // Write file to disk
  writeFile: (filePath, buffer) => ipcRenderer.invoke('write-file', filePath, buffer),

  // Read file from disk
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

  // OS-level encrypted storage for recovery phrase
  safeEncrypt: (plaintext) => ipcRenderer.invoke('safe-encrypt', plaintext),
  safeDecrypt: (encryptedB64) => ipcRenderer.invoke('safe-decrypt', encryptedB64),

  // ── Sia bridge (native NAPI SDK) ──────────────────────

  siaConnect: (appIdHex, appKeyHex) => ipcRenderer.invoke('sia-connect', appIdHex, appKeyHex),
  siaDisconnect: () => ipcRenderer.invoke('sia-disconnect'),
  siaAccount: () => ipcRenderer.invoke('sia-account'),
  siaUpload: (fileName, fileBuffer, mimeType) => ipcRenderer.invoke('sia-upload', fileName, fileBuffer, mimeType),
  siaDownload: (objectId) => ipcRenderer.invoke('sia-download', objectId),
  siaListFiles: () => ipcRenderer.invoke('sia-list-files'),
  siaDelete: (objectId) => ipcRenderer.invoke('sia-delete', objectId),
  siaShare: (objectId) => ipcRenderer.invoke('sia-share', objectId),

  // Progress events from main process
  onUploadProgress: (callback) => {
    const handler = (_event, progress) => callback(progress)
    ipcRenderer.on('sia-upload-progress', handler)
    return () => ipcRenderer.removeListener('sia-upload-progress', handler)
  },

  // Flag: are we running in Electron?
  isDesktop: true,
})