// @tessera/shared — UI controller
//
// Mounts the complete SPA into a container.  Imported by both
// web and desktop entry points.

import { initSia, registerSdk } from './sdk.js'
import {
  beginConnection,
  waitForApproval,
  completeRegistration,
  tryReconnect,
  clearCredentials,
  getSaved,
  beginRecovery,
  completeRecovery,
} from './auth.js'
import {
  listFiles, computeTotals, uploadFile, downloadToDisk,
  deleteFile, createShareURL, getObject, getAccount, waitForReady, initRelay,
} from './files.js'
import {
  getState, patchState, subscribe, selectedFile,
  showToast, setBusy, setScreen,
} from './store.js'
import { formatBytes, esc, fmtDateTime, $ } from './utils.js'

// ── refs ─────────────────────────────────────────────────
let root
const r = {}
let _recoveryMode = false   // true when we're in the recovery flow (vs new-account connect)

function cacheRefs() {
  const ids = [
    'header','readyDot','storageSummary','btnLogout',
    'connectScreen','connectHint','btnConnect','connectApprovalBox','approvalLink','approvalUrl',
    'connectStatus','connectRetry','btnRecoverAccount',
    'recoverScreen','recoverPhraseInput','btnRecover','recoverStatus','btnBackToConnect',
    'phraseScreen','phraseText','btnPhraseDone','phraseStatus',
    'phraseEncryptCheck','phraseEncryptFields','phrasePassword','phrasePasswordConfirm',
    'mainScreen','dropzone','fileInput','fileList','fileActions',
    'btnDownload','btnShare','btnDelete',
    'statusText','progressWrap','progressFill','progressLabel',
    'shareModal','shareLink','btnCopyLink','btnCloseModal',
    'toast',
  ]
  for (const id of ids) r[id] = $(id)
}

// ── HTML skeleton ───────────────────────────────────────

const SKELETON = /*html*/`
<div id="tessera-app">

  <header id="header" class="app-header hidden">
    <span class="logo">Tessera</span>
    <span id="readyDot" class="dot off" title="Account status"></span>
    <span id="storageSummary" class="storage-summary"></span>
    <button id="btnLogout" class="btn btn-ghost btn-logout">Log out</button>
  </header>

  <!-- CONNECT -->
  <section id="connectScreen" class="panel">
    <h2>Connect to Tessera</h2>
    <p>
      Tessera stores your files on the <strong>Sia network</strong> —
      encrypted, erasure-coded, and spread across 30 independent hosts.
      No single point of failure.
    </p>
    <p style="margin-top:12px">
      <button id="btnConnect" class="btn btn-primary btn-lg" disabled>Connect</button>
    </p>
    <p style="margin-top:8px">
      <button id="btnRecoverAccount" class="btn btn-ghost">Recover existing account</button>
    </p>
    <div id="connectApprovalBox" class="hidden" style="margin-top:14px">
      <p style="color:var(--amber);font-weight:500">
        \u{1F517} Open this link to approve:
      </p>
      <a id="approvalLink" href="#" target="_blank" rel="noopener"
         class="btn btn-primary btn-lg"
         style="display:block;text-align:center;text-decoration:none;word-break:break-all;font-size:12px;margin-top:8px">
      </a>
      <input id="approvalUrl" type="text" readonly
             style="margin-top:8px;font-size:11px;font-family:var(--font-mono);color:var(--ink3)">
      <p style="font-size:12px;color:var(--ink3);margin-top:6px">
        After approving, come back here. <button id="connectRetry" class="btn btn-ghost" style="font-size:12px;padding:3px 8px">Retry</button>
      </p>
    </div>
    <p id="connectHint" class="hint" style="margin-top:8px">Loading\u2026</p>
    <p id="connectStatus" class="status-text"></p>
  </section>

  <!-- RECOVER -->
  <section id="recoverScreen" class="panel hidden">
    <h2>Recover your account</h2>
    <p>
      Enter your <strong>12-word recovery phrase</strong> to restore
      your account. The phrase was shown to you when you first connected.
    </p>
    <textarea id="recoverPhraseInput" class="recover-input"
              placeholder="Enter your 12-word recovery phrase\u2026"
              rows="3" autocomplete="off" spellcheck="false"></textarea>
    <p style="margin-top:14px">
      <button id="btnRecover" class="btn btn-primary btn-lg">Recover my account</button>
    </p>
    <p style="margin-top:8px">
      <button id="btnBackToConnect" class="btn btn-ghost">\u2190 Back to Connect</button>
    </p>
    <p id="recoverStatus" class="status-text"></p>
  </section>

  <!-- PHRASE -->
  <section id="phraseScreen" class="panel hidden">
    <h2>Save your recovery phrase</h2>
    <p>
      These <strong>12 words</strong> are the only way to recover your
      account. Write them down or save them in a password manager.
    </p>
    <pre id="phraseText" class="phrase-box"></pre>
    <label class="check-row">
      <input type="checkbox" id="phraseEncryptCheck">
      <span>Encrypt &amp; save locally with a master password</span>
    </label>
    <div id="phraseEncryptFields" class="hidden" style="display:flex;flex-direction:column;gap:8px;margin:8px 0">
      <input type="password" id="phrasePassword" placeholder="Master password" autocomplete="new-password">
      <input type="password" id="phrasePasswordConfirm" placeholder="Confirm password" autocomplete="new-password">
    </div>
    <p style="margin-top:14px">
      <button id="btnPhraseDone" class="btn btn-primary btn-lg">I have saved them</button>
    </p>
    <p id="phraseStatus" class="status-text"></p>
  </section>

  <!-- MAIN -->
  <section id="mainScreen" class="panel hidden">
    <div id="dropzone" class="dropzone">
      <div class="dz-icon">\u{1F4C1}</div>
      <div class="dz-text">Drop files here to upload</div>
      <div class="dz-hint">or click to browse</div>
    </div>
    <input type="file" id="fileInput" hidden>

    <div id="progressWrap" class="progress-wrap hidden">
      <div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>
      <div class="progress-label"><span id="progressLabel"></span></div>
    </div>

    <div id="fileList" class="file-list"></div>

    <div id="fileActions" class="actions-bar hidden">
      <button id="btnDownload" class="btn" disabled>Download</button>
      <button id="btnShare" class="btn" disabled>Share</button>
      <button id="btnDelete" class="btn btn-danger" disabled>Delete</button>
    </div>
    <p id="statusText" class="status-text"></p>
  </section>

  <!-- SHARE MODAL -->
  <div id="shareModal" class="modal-overlay hidden">
    <div class="modal-card">
      <h3>Share link</h3>
      <p class="hint">Anyone with this link can download the file. Valid 30 days.</p>
      <input type="text" id="shareLink" readonly>
      <div class="modal-buttons">
        <button id="btnCopyLink" class="btn btn-primary">Copy link</button>
        <button id="btnCloseModal" class="btn btn-ghost">Close</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

</div>`

// ── mount ────────────────────────────────────────────────

export async function mountApp(container) {
  root = typeof container === 'string' ? document.querySelector(container) : container
  if (!root) throw new Error('Container not found')

  root.innerHTML = SKELETON
  root.classList.remove('boot-spinner')
  cacheRefs()

  // wire events
  r.btnConnect.addEventListener('click', onConnect)
  r.connectRetry.addEventListener('click', onConnectRetry)
  r.btnRecoverAccount.addEventListener('click', onShowRecover)
  r.btnBackToConnect.addEventListener('click', onBackToConnect)
  r.btnRecover.addEventListener('click', onSubmitRecovery)
  r.btnPhraseDone.addEventListener('click', onPhraseDone)
  r.btnLogout.addEventListener('click', onLogout)
  r.phraseEncryptCheck.addEventListener('change', () => {
    r.phraseEncryptFields.classList.toggle('hidden', !r.phraseEncryptCheck.checked)
  })
  // Dropzone: desktop uses native file dialog, web uses hidden <input>
  if (window.tesseraDesktop && window.tesseraDesktop.isDesktop) {
    r.dropzone.addEventListener('click', () => doUpload(null))
  } else {
    r.dropzone.addEventListener('click', () => r.fileInput.click())
  }
  r.fileInput.addEventListener('change', onFilePicked)
  r.btnDownload.addEventListener('click', onDownload)
  r.btnDelete.addEventListener('click', onDelete)
  r.btnShare.addEventListener('click', onShare)
  r.btnCloseModal.addEventListener('click', closeShareModal)
  r.btnCopyLink.addEventListener('click', onCopyLink)

  // drag & drop
  r.dropzone.addEventListener('dragover', e => { e.preventDefault(); r.dropzone.classList.add('dragover') })
  r.dropzone.addEventListener('dragleave', () => r.dropzone.classList.remove('dragover'))
  r.dropzone.addEventListener('drop', e => {
    e.preventDefault(); r.dropzone.classList.remove('dragover')
    const f = e.dataTransfer.files; if (f && f.length) doUpload(f[0])
  })

  // state → DOM
  subscribe('screen', v => renderScreen(v))
  subscribe('accountReady', v => { r.readyDot.className = 'dot ' + (v ? 'on' : 'off') })
  subscribe('toast', v => { r.toast.textContent = v })
  subscribe('status', v => { r.statusText.textContent = v || '' })
  subscribe('busy', v => {
    const sf = selectedFile()
    r.btnDownload.disabled = v || !sf
    r.btnShare.disabled   = v || !sf
    r.btnDelete.disabled  = v || !sf
  })
  subscribe('files', () => { renderFileList(); updateTotals() })
  subscribe('selectedIdx', () => {
    renderFileList()
    const sf = selectedFile()
    r.btnDownload.disabled = !sf || getState().busy
    r.btnShare.disabled    = !sf || getState().busy
    r.btnDelete.disabled   = !sf || getState().busy
    r.fileActions.classList.toggle('hidden', !sf)
  })
  subscribe('progress', v => {
    if (v) {
      r.progressWrap.classList.remove('hidden')
      r.progressFill.style.width = v.percent + '%'
      r.progressLabel.textContent = v.stage + (v.elapsed ? ' \u00b7 ' + Math.round(v.elapsed/1000) + 's' : '')
    } else {
      r.progressWrap.classList.add('hidden')
    }
  })

  await doBoot()
}

// ── screens ──────────────────────────────────────────────

function renderScreen(s) {
  r.connectScreen.classList.toggle('hidden', s !== 'connect' && s !== 'recoverApproval')
  r.recoverScreen.classList.toggle('hidden', s !== 'recover')
  r.phraseScreen.classList.toggle('hidden', s !== 'phrase')
  r.mainScreen.classList.toggle('hidden', s !== 'main')
  r.header.classList.toggle('hidden', s === 'loading')
}

// ── boot ─────────────────────────────────────────────────

async function doBoot() {
  _recoveryMode = false
  r.connectHint.textContent = 'Loading\u2026'
  r.btnConnect.disabled = true
  r.btnRecoverAccount.disabled = true
  setScreen('connect')

  try { await initSia() } catch (e) {
    r.connectHint.textContent = 'Failed to start. Please refresh the page.'
    console.error(e); return
  }

  // try reconnect
  const saved = getSaved()
  if (saved.appKey && saved.appId) {
    r.connectHint.textContent = 'Reconnecting\u2026'
    const sdk = await tryReconnect()
    if (sdk) { patchState({ sdk }); registerSdk(sdk); await initNativeBridge(); await initRelay(); await enterMain(); return }
    clearCredentials()
  }

  r.connectHint.textContent = 'Click Connect to link this browser to your Tessera account.'
  r.btnConnect.disabled = false
  r.btnRecoverAccount.disabled = false
}

// ── connect ──────────────────────────────────────────────

async function onConnect() {
  _recoveryMode = false
  r.btnConnect.disabled = true
  r.btnRecoverAccount.disabled = true
  r.connectHint.textContent = 'Contacting indexer\u2026'
  r.connectStatus.textContent = ''

  try {
    const { builder, appId, approvalUrl } = await beginConnection()

    // Show the approval link (user MUST click it — popup blocker safe)
    r.approvalLink.href = approvalUrl
    r.approvalLink.textContent = 'Open Tessera approval page \u2197'
    r.approvalUrl.value = approvalUrl
    r.connectApprovalBox.classList.remove('hidden')
    r.connectHint.textContent = 'Click the button above, enter your connect key, then come back.'
    r.connectStatus.textContent = ''

    // Poll for approval in the background
    const result = await waitForApproval(builder, appId, msg => {
      r.connectStatus.textContent = msg
    })

    patchState({ builder: result.builder, appId: result.appId, phrase: result.phrase })
    r.phraseText.textContent = result.phrase
    r.connectApprovalBox.classList.add('hidden')
    setScreen('phrase')
  } catch (e) {
    r.connectStatus.textContent = 'Connection failed: ' + (e.message || 'Unknown error')
    r.btnConnect.disabled = false
    r.btnRecoverAccount.disabled = false
    console.error(e)
  }
}

async function onConnectRetry() {
  _recoveryMode = false
  r.connectApprovalBox.classList.add('hidden')
  r.btnConnect.disabled = false
  r.btnRecoverAccount.disabled = false
  r.btnConnect.classList.remove('hidden')
  r.connectStatus.textContent = ''
  r.connectHint.textContent = 'Click Connect to try again.'
}

// ── recovery ─────────────────────────────────────────────

function onShowRecover() {
  _recoveryMode = true
  r.recoverPhraseInput.value = ''
  r.recoverStatus.textContent = ''
  r.connectApprovalBox.classList.add('hidden')
  setScreen('recover')
}

function onBackToConnect() {
  _recoveryMode = false
  r.connectApprovalBox.classList.add('hidden')
  r.connectStatus.textContent = ''
  r.recoverStatus.textContent = ''
  setScreen('connect')
  // re-enable connect buttons
  r.btnConnect.disabled = false
  r.btnRecoverAccount.disabled = false
  r.connectHint.textContent = 'Click Connect to link this browser to your Tessera account.'
}

async function onSubmitRecovery() {
  const phrase = r.recoverPhraseInput.value.trim()
  if (!phrase) {
    r.recoverStatus.textContent = 'Please enter your 12-word recovery phrase.'
    return
  }

  // Basic check: should have at least a few words
  if (phrase.split(/\s+/).length < 12) {
    r.recoverStatus.textContent = 'Please enter all 12 words of your recovery phrase.'
    return
  }

  r.btnRecover.disabled = true
  r.btnBackToConnect.disabled = true
  r.recoverStatus.textContent = ''

  try {
    const result = await beginRecovery(phrase, msg => {
      r.recoverStatus.textContent = msg
    })

    if (!result.needsApproval) {
      // Direct recovery succeeded
      patchState({ sdk: result.sdk, builder: null, phrase: '' })
      registerSdk(result.sdk)
      await initNativeBridge()
      await initRelay()
      await enterMain()
      return
    }

    // Needs approval — show approval box (reuse connectApprovalBox)
    r.approvalLink.href = result.approvalUrl
    r.approvalLink.textContent = 'Open Tessera approval page \u2197'
    r.approvalUrl.value = result.approvalUrl
    r.connectApprovalBox.classList.remove('hidden')
    // Override the retry button to trigger recovery retry
    r.connectRetry.onclick = onRecoverRetry

    // Store recovery context in state
    patchState({ builder: result.builder, appId: result.appId, phrase: result.phrase })

    setScreen('recoverApproval')

    // Poll for approval
    await result.builder.waitForApproval()
    r.recoverStatus.textContent = 'Approved! Completing recovery\u2026'

    // Complete recovery
    const sdk = await completeRecovery(result.builder, result.phrase)
    patchState({ sdk, builder: null, phrase: '' })
    registerSdk(sdk)
    r.connectApprovalBox.classList.add('hidden')
    await initNativeBridge()
    await initRelay()
    await enterMain()
  } catch (e) {
    const msg = e.message || 'Unknown error'
    r.recoverStatus.textContent = 'Recovery failed: ' + msg
    r.btnRecover.disabled = false
    r.btnBackToConnect.disabled = false
    console.error(e)
  }
}

async function onRecoverRetry() {
  r.connectApprovalBox.classList.add('hidden')
  r.recoverStatus.textContent = ''
  setScreen('recover')
  r.btnRecover.disabled = false
  r.btnBackToConnect.disabled = false
  // Restore normal retry behavior
  r.connectRetry.onclick = onConnectRetry
}

// ── phrase ───────────────────────────────────────────────

async function onPhraseDone() {
  const { builder, phrase } = getState()
  if (!builder) return

  r.btnPhraseDone.disabled = true
  r.phraseStatus.textContent = 'Registering\u2026'

  // optional local encryption
  if (r.phraseEncryptCheck.checked) {
    const pw = r.phrasePassword.value
    if (pw) {
      const confirm = r.phrasePasswordConfirm.value
      if (pw !== confirm) {
        r.phraseStatus.textContent = 'Passwords do not match.'
        r.btnPhraseDone.disabled = false; return
      }
      // Store encrypted phrase in localStorage
      try {
        const enc = await encryptPhraseLocal(phrase, pw)
        localStorage.setItem('tessera.penc', enc.encrypted)
        localStorage.setItem('tessera.psalt', enc.salt)
      } catch (e) { /* non-critical */ }
    }
  }

  try {
    const sdk = await completeRegistration(builder, phrase)
    patchState({ sdk, builder: null, phrase: '' })
    registerSdk(sdk)
    await initNativeBridge()
    await initRelay()
    await enterMain()
  } catch (e) {
    r.phraseStatus.textContent = 'Registration failed: ' + (e.message || 'Unknown error')
    r.btnPhraseDone.disabled = false
    console.error(e)
  }
}

// simple AES-GCM for phrase encryption (browser-native Web Crypto)
async function encryptPhraseLocal(phrase, password) {
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(phrase))
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv); combined.set(new Uint8Array(ciphertext), iv.length)
  return {
    encrypted: btoa(String.fromCharCode(...combined)),
    salt: btoa(String.fromCharCode(...salt)),
  }
}

// ── main screen ──────────────────────────────────────────

async function enterMain() {
  setScreen('main')
  const sdk = getState().sdk

  try {
    patchState({ status: 'Checking account\u2026' })
    await waitForReady(sdk)
    const acct = await getAccount(sdk)
    patchState({ accountReady: !!acct.ready, status: '' })
    await refreshFiles()
  } catch (e) {
    patchState({ status: 'Could not load files: ' + (e.message || 'error') })
    console.error(e)
  }
}

async function refreshFiles() {
  const sdk = getState().sdk
  if (!sdk) return
  const files = await listFiles(sdk)
  const totals = computeTotals(files)
  patchState({ files, totals, selectedIdx: -1 })
}

function updateTotals() {
  const { totals } = getState()
  r.storageSummary.textContent = totals.count
    ? totals.count + ' file' + (totals.count !== 1 ? 's' : '') + ' \u00b7 ' + formatBytes(totals.totalBytes)
    : ''
}

// ── file list rendering ──────────────────────────────────

function renderFileList() {
  const { files, selectedIdx } = getState()
  r.fileList.innerHTML = ''

  if (!files.length) {
    r.fileList.innerHTML =
      '<div class="empty-state"><div class="empty-icon">\u{1F4E6}</div>' +
      '<div class="empty-title">No files yet</div>' +
      '<div class="empty-sub">Drop a file above to get started</div></div>'
    return
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const row = document.createElement('div')
    row.className = 'file-row' + (i === selectedIdx ? ' selected' : '')
    const ext = (f.name || '').split('.').pop()?.toLowerCase() || ''
    row.innerHTML =
      '<span class="file-icon">' + fileIcon(ext) + '</span>' +
      '<div class="file-info">' +
        '<span class="file-name">' + esc(f.name) + '</span>' +
        '<span class="file-meta">' + esc(fmtDateTime(f.updatedAt)) + '</span>' +
      '</div>' +
      '<span class="file-size">' + esc(formatBytes(f.size)) + '</span>'
    row.addEventListener('click', () => patchState({ selectedIdx: i }))
    r.fileList.appendChild(row)
  }
}

function fileIcon(ext) {
  const m = {
    pdf:'\u{1F4C4}',doc:'\u{1F4DD}',docx:'\u{1F4DD}',
    xls:'\u{1F4CA}',xlsx:'\u{1F4CA}',
    png:'\u{1F5BC}',jpg:'\u{1F5BC}',jpeg:'\u{1F5BC}',gif:'\u{1F5BC}',svg:'\u{1F5BC}',webp:'\u{1F5BC}',
    mp4:'\u{1F3AC}',mov:'\u{1F3AC}',avi:'\u{1F3AC}',
    mp3:'\u{1F3B5}',wav:'\u{1F3B5}',flac:'\u{1F3B5}',
    zip:'\u{1F4E6}',rar:'\u{1F4E6}','7z':'1F4E6',tar:'\u{1F4E6}',gz:'\u{1F4E6}',
    js:'\u{1F4BB}',ts:'\u{1F4BB}',py:'\u{1F4BB}',go:'\u{1F4BB}',rs:'\u{1F4BB}',
    html:'\u{1F310}',css:'\u{1F310}',json:'\u{1F4CB}',md:'\u{1F4DD}',txt:'\u{1F4C4}',
  }
  return m[ext] || '\u{1F4C4}'
}

// ── file ops ─────────────────────────────────────────────

function onFilePicked() {
  const f = r.fileInput.files && r.fileInput.files[0]
  r.fileInput.value = ''
  if (f) doUpload(f)
}

async function doUpload(file) {
  const sdk = getState().sdk; if (!sdk) return
  setBusy(true)
  patchState({ status: '', progress: { stage: 'Preparing\u2026', percent: 0, elapsed: 0 } })
  try {
    await waitForReady(sdk)
    const obj = await uploadFile(sdk, file, ({ stage, percent, elapsed }) => {
      patchState({ progress: { stage, percent, elapsed } })
    })
    patchState({ progress: null })
    const name = (file && file.name) || (obj && obj.id && obj.id.slice(0, 12) + '...')
    showToast('\u2705 ' + (name || 'File') + ' uploaded')
    await refreshFiles()
  } catch (e) {
    patchState({ progress: null, status: 'Upload failed: ' + (e.message || 'error') })
    console.error(e)
  } finally { setBusy(false) }
}

async function onDownload() {
  const sf = selectedFile(); if (!sf) return
  const sdk = getState().sdk; if (!sdk) return
  setBusy(true); patchState({ status: 'Downloading\u2026' })
  try {
    await downloadToDisk(sdk, sf.id, sf.name)
    showToast('\u2B07\uFE0F Downloaded: ' + sf.name)
    patchState({ status: '' })
  } catch (e) {
    patchState({ status: 'Download failed: ' + (e.message || 'error') })
    console.error(e)
  } finally { setBusy(false) }
}

async function onDelete() {
  const sf = selectedFile(); if (!sf) return
  const sdk = getState().sdk; if (!sdk) return
  if (!confirm('Delete "' + sf.name + '"?\n\nThis cannot be undone. The file will be unpinned from Sia.')) return
  setBusy(true); patchState({ status: 'Deleting\u2026' })
  try {
    await deleteFile(sdk, sf.id)
    showToast('\u{1F5D1}\uFE0F Deleted: ' + sf.name)
    await refreshFiles()
    patchState({ status: '' })
  } catch (e) {
    patchState({ status: 'Delete failed: ' + (e.message || 'error') })
    console.error(e)
  } finally { setBusy(false) }
}

async function onShare() {
  const sf = selectedFile(); if (!sf) return
  const sdk = getState().sdk; if (!sdk) return
  try {
    r.shareLink.value = await createShareURL(sdk, sf.id)
    r.shareModal.classList.remove('hidden')
  } catch (e) { showToast('Failed to create share link'); console.error(e) }
}

function closeShareModal() { r.shareModal.classList.add('hidden') }

async function onCopyLink() {
  try { await navigator.clipboard.writeText(r.shareLink.value) } catch (_) {
    r.shareLink.select(); r.shareLink.setSelectionRange(0, 99999); document.execCommand('copy')
  }
  showToast('\u{1F4CB} Link copied')
  closeShareModal()
}

// ── logout ───────────────────────────────────────────────

function onLogout() {
  if (!confirm('Remove all local credentials? You will need your recovery phrase to log back in.')) return
  clearCredentials()
  // Disconnect native bridge if in desktop mode
  if (window.tesseraDesktop && window.tesseraDesktop.isDesktop) {
    window.tesseraDesktop.siaDisconnect().catch(() => {})
  }
  patchState({
    sdk: null, screen: 'connect', accountReady: false,
    files: [], selectedIdx: -1, totals: { count: 0, totalBytes: 0 },
    builder: null, phrase: '', status: '', progress: null,
  })
  doBoot()
}

// ── native bridge (desktop) ──────────────────────────────

/**
 * In the Electron desktop app, also connect the native NAPI SDK
 * in the main process so upload/download work via raw TCP.
 */
async function initNativeBridge() {
  if (!window.tesseraDesktop || !window.tesseraDesktop.isDesktop) return
  const saved = getSaved()
  if (!saved.appKey || !saved.appId) return
  try {
    const result = await window.tesseraDesktop.siaConnect(saved.appId, saved.appKey)
    if (!result.ok) console.warn('Native bridge connect failed:', result.error)
  } catch (e) {
    console.warn('Native bridge unavailable:', e.message)
  }
}