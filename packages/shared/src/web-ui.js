// @tessera/shared — Tessera Web controller
//
// Siacentral-lite-wallet-style front door: Welcome -> Create (invite ->
// words -> password) or "I have my words" (phrase -> password) -> Files.
// Reuses auth.js/vault.js/files.js/sdk.js exactly as Drop does, through
// the 'tesseraweb' localStorage prefix (Drop's tessera.* keys untouched
// -- see PREFIX comments in auth.js/vault.js/files.js). This is a
// SEPARATE module from ui.js: it does not import or touch any of Drop's
// screen HTML, only the shared plumbing underneath it.
//
// PRELOAD (2026-09-14 law): "GET /hosts / hosts() occupies. Do not call
// it during onboarding or as a preload." -- the only preload work done
// here is (1) initSia() [wasm engine start], (2) warming the indexer
// proxy with a harmless account() read (not hosts()). Both fire in the
// background right after first paint and are never awaited by the
// Welcome/Create/Unlock screens -- if the human finishes those screens
// before preload resolves, enterFiles() below just awaits initSia()
// again, which is a no-op once _ready is true (see sdk.js).

import { initSia, registerSdk } from './sdk.js'
import {
  connectWithInvite, completeRegistration,
  tryReconnect, reconnectWithAppKey, clearCredentials, getSaved,
  beginRecovery, completeRecovery, setUnlockPassword,
} from './auth.js'
import {
  listFiles, computeTotals, uploadFile, downloadToDisk,
  deleteFile, createShareURL, getAccount, waitForReady, initRelay,
  setCredsPrefix,
  buildPath, folderMarkerName, validateFolderName, computeFolderView,
  isNonEmptyFolder, findFolderMarkerId, createFolderMarker,
} from './files.js'
import { createUploadMap } from './map.js'
import {
  getState, patchState, subscribe, selectedFile,
  showToast, setBusy, setScreen,
} from './store.js'
import { formatBytes, esc, fmtDateTime, $ } from './utils.js'
import { hasWrappedVault, unwrapAppKey } from './vault.js'

const PREFIX = 'tesseraweb'

let root
const r = {}

function cacheRefs() {
  const ids = [
    'header', 'readyDot', 'storageSummary', 'btnLock',
    'welcomeScreen', 'btnCreate', 'btnHaveWords',
    'inviteScreen', 'inviteInput', 'btnInviteContinue', 'inviteRequestLink', 'inviteStatus',
    'requestStubScreen', 'btnRequestBack',
    'wordsScreen', 'wordsText', 'btnWordsSaved', 'wordsStatus',
    'setPasswordScreen', 'newPassword', 'newPasswordConfirm',
    'btnSetPassword', 'setPasswordStatus',
    'readyWaitScreen', 'readyWaitStatus',
    'recoverScreen', 'recoverPhraseInput', 'btnRecoverContinue', 'recoverStatus',
    'unlockScreen', 'unlockPassword', 'btnUnlock', 'unlockStatus', 'btnForgotPassword',
    'filesScreen', 'dropzone', 'fileInput', 'fileList', 'fileActions',
    'btnDownload', 'btnShare', 'btnDelete', 'btnRemoveBrowser',
    'btnNewFolder', 'breadcrumb',
    'filesLayout', 'btnShowMap', 'mapPane', 'btnHideMap', 'mapCanvas',
    'statusText', 'progressWrap', 'progressFill', 'progressLabel',
    'shareModal', 'shareLink', 'btnCopyLink', 'btnCloseModal',
    'toast',
  ]
  for (const id of ids) r[id] = $(id)
}

// ── HTML skeleton (exact copy from the packet) ────────────

const SKELETON = /*html*/`
<div id="tessera-web-app">

  <header id="header" class="app-header hidden">
    <span class="logo">Tessera</span>
    <span id="readyDot" class="dot off" title="Account status"></span>
    <span id="storageSummary" class="storage-summary"></span>
    <button id="btnLock" class="btn btn-ghost btn-logout">Lock this browser</button>
  </header>

  <!-- WELCOME -->
  <section id="welcomeScreen" class="panel welcome-panel">
    <span class="welcome-brand">Tessera</span>
    <div class="welcome-center">
      <p>Your files. This browser.</p>
      <p style="margin-top:14px">
        <button id="btnCreate" class="btn btn-outline btn-lg">I&rsquo;m new</button>
      </p>
      <p style="margin-top:8px">
        <button id="btnHaveWords" class="btn btn-outline btn-lg">I already have an account</button>
      </p>
    </div>
  </section>

  <!-- CREATE: INVITE -->
  <section id="inviteScreen" class="panel column-screen hidden">
    <h2>Invite</h2>
    <input type="text" id="inviteInput" placeholder="Invite" autocomplete="off" style="margin-top:14px">
    <p style="margin-top:14px">
      <button id="btnInviteContinue" class="btn btn-primary btn-lg">Continue</button>
    </p>
    <p class="hint" style="margin-top:10px">
      Don&rsquo;t have an invite yet? <a href="#" id="inviteRequestLink">Request one here.</a>
    </p>
    <p id="inviteStatus" class="status-text"></p>
  </section>

  <!-- CREATE: REQUEST STUB (named, not designed) -->
  <section id="requestStubScreen" class="panel column-screen hidden">
    <h2>Need an invite?</h2>
    <p>Ask the person who sent you here.</p>
    <p style="margin-top:14px">
      <button id="btnRequestBack" class="btn btn-outline btn-lg">Back</button>
    </p>
  </section>

  <!-- CREATE: WORDS -->
  <section id="wordsScreen" class="panel column-screen hidden">
    <h2>Save these words</h2>
    <p>Write these 12 words on paper. They rebuild this account on a new device.</p>
    <pre id="wordsText" class="phrase-box"></pre>
    <p style="margin-top:14px">
      <button id="btnWordsSaved" class="btn btn-primary btn-lg">I saved them</button>
    </p>
    <p id="wordsStatus" class="status-text"></p>
  </section>

  <!-- CREATE: PASSWORD (also used by I-have-my-words -> Set a password) -->
  <section id="setPasswordScreen" class="panel column-screen hidden">
    <h2>Set a password</h2>
    <p>Password for this browser. Never stored.</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin:14px 0">
      <input type="password" id="newPassword" placeholder="Password" autocomplete="new-password">
      <input type="password" id="newPasswordConfirm" placeholder="Confirm password" autocomplete="new-password">
    </div>
    <p style="margin-top:8px">
      <button id="btnSetPassword" class="btn btn-primary btn-lg">Set password</button>
    </p>
    <p id="setPasswordStatus" class="status-text"></p>
  </section>

  <!-- READY WAIT -->
  <section id="readyWaitScreen" class="panel column-screen hidden">
    <h2>Tessera</h2>
    <p>Setting up this browser&hellip;</p>
    <p id="readyWaitStatus" class="status-text"></p>
  </section>

  <!-- I HAVE MY WORDS -->
  <section id="recoverScreen" class="panel column-screen hidden">
    <h2>Tessera</h2>
    <p>Type your 12 words.</p>
    <textarea id="recoverPhraseInput" class="recover-input"
              placeholder="Enter your 12 words\u2026"
              rows="3" autocomplete="off" spellcheck="false"></textarea>
    <p style="margin-top:14px">
      <button id="btnRecoverContinue" class="btn btn-primary btn-lg">Continue</button>
    </p>
    <p id="recoverStatus" class="status-text"></p>
  </section>

  <!-- UNLOCK -->
  <section id="unlockScreen" class="panel column-screen hidden">
    <h2>Unlock</h2>
    <input type="password" id="unlockPassword" placeholder="Password for this browser." autocomplete="current-password" style="margin-top:14px">
    <p style="margin-top:14px">
      <button id="btnUnlock" class="btn btn-primary btn-lg">Unlock</button>
    </p>
    <p style="margin-top:8px">
      <button id="btnForgotPassword" class="btn btn-ghost">Forgot password</button>
    </p>
    <p id="unlockStatus" class="status-text"></p>
  </section>


  <!-- FILES + MAP -->
  <div id="filesLayout" class="files-layout">
    <section id="filesScreen" class="panel column-screen hidden">
      <h2>Tessera</h2>
      <!-- SHOW MAP (2026-09-14, "tessera-web-map-tune"): "Link top-right
           of the files/drop pane, above and to the right of the Tessera
           logo." Moved here (was previously a full-width button below
           'Remove from this browser') and repositioned via CSS to
           absolute top-right, matching #btnHideMap's own corner
           placement on the map pane -- "same pair as Hide map." -->
      <button id="btnShowMap" class="btn btn-ghost btn-show-map hidden">Show map</button>
      <!-- BREADCRUMB (2026-09-15, "tessera-web-folders-v1"): "Files >
           Photos > Italy. Files is root. Each segment is a tap." One
           span per segment, built by renderBreadcrumb() -- never a
           second in-page Back, only forward navigation by tapping an
           ancestor segment (Browser Back is the real history API,
           wired separately below). -->
      <div id="breadcrumb" class="breadcrumb"></div>
      <div class="files-toolbar">
        <div id="dropzone" class="dropzone">
          <div class="dz-icon">\u{1F4C1}</div>
          <div class="dz-text">Add a file</div>
          <div class="dz-hint">or click to browse</div>
        </div>
        <button id="btnNewFolder" class="btn btn-outline btn-new-folder">New folder</button>
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
      <p style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <button id="btnRemoveBrowser" class="btn btn-ghost">Remove from this browser</button>
      </p>
    </section>

    <aside id="mapPane" class="map-pane hidden">
      <button id="btnHideMap" class="btn btn-ghost btn-hide-map">Hide map</button>
      <canvas id="mapCanvas" class="map-canvas"></canvas>
      <!-- CAPTION KILLED (2026-09-15, "tessera-web-map-follow"):
           "Kill the map caption... No replacement sentence this
           packet. Progress stays on the files pane as N/30." The
           #mapCaption element itself is removed, not just left empty
           -- there is no lower-left text node on the map pane at all
           anymore. -->
    </aside>
  </div>

  <!-- SHARE MODAL -->
  <div id="shareModal" class="modal-overlay hidden">
    <div class="modal-card">
      <h3>Share link</h3>
      <p class="hint">The link is not the file sitting in this tab.</p>
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
  setCredsPrefix(PREFIX)

  root = typeof container === 'string' ? document.querySelector(container) : container
  if (!root) throw new Error('Container not found')

  root.innerHTML = SKELETON
  root.classList.remove('boot-spinner')
  cacheRefs()

  // wire events
  r.btnCreate.addEventListener('click', onShowInvite)
  r.btnHaveWords.addEventListener('click', onShowRecover)
  r.btnInviteContinue.addEventListener('click', onInviteContinue)
  r.inviteRequestLink.addEventListener('click', e => { e.preventDefault(); onShowRequestStub() })
  r.btnRequestBack.addEventListener('click', () => history.back())
  r.btnWordsSaved.addEventListener('click', onWordsSaved)
  r.btnSetPassword.addEventListener('click', onSetPassword)
  r.btnRecoverContinue.addEventListener('click', onRecoverContinue)
  r.btnUnlock.addEventListener('click', onUnlock)
  r.btnForgotPassword.addEventListener('click', onForgotPassword)
  r.btnLock.addEventListener('click', onLock)
  r.btnRemoveBrowser.addEventListener('click', onRemoveBrowser)
  r.btnHideMap.addEventListener('click', hideMap)
  r.btnShowMap.addEventListener('click', showMap)
  r.btnNewFolder.addEventListener('click', onNewFolder)
  r.breadcrumb.addEventListener('click', onBreadcrumbClick)

  r.dropzone.addEventListener('click', () => r.fileInput.click())
  r.fileInput.addEventListener('change', onFilePicked)
  r.btnDownload.addEventListener('click', onDownload)
  r.btnDelete.addEventListener('click', onDelete)
  r.btnShare.addEventListener('click', onShare)
  r.btnCloseModal.addEventListener('click', closeShareModal)
  r.btnCopyLink.addEventListener('click', onCopyLink)

  r.dropzone.addEventListener('dragover', e => { e.preventDefault(); r.dropzone.classList.add('dragover') })
  r.dropzone.addEventListener('dragleave', () => r.dropzone.classList.remove('dragover'))
  r.dropzone.addEventListener('drop', e => {
    e.preventDefault(); r.dropzone.classList.remove('dragover')
    const f = e.dataTransfer.files; if (f && f.length) enqueueUpload(f[0])
  })

  // Browser Back (2026-09-14, "tessera-web-column-back-invite"): real History
  // API, not an in-page Back that fights browser chrome. popstate ONLY calls
  // setScreen() -- it never resets input values (so a wrong tap / accidental
  // Back never wipes what the customer already typed) and never touches
  // credentials/vault (Unlock and the create steps stay exactly as they were
  // when the user left them; deletion only ever happens from the explicit
  // "Remove from this browser" button, never from navigation).
  window.addEventListener('popstate', (e) => {
    const screen = (e.state && e.state.screen) || (hasWrappedVault(PREFIX) ? 'unlock' : 'welcome')
    // FOLDERS (2026-09-15, "tessera-web-folders-v1"): "Browser Back
    // leaves the folder (history API, same as onboard). Do not invent
    // a second in-page Back that fights the chrome." e.state.path is
    // only ever set for screen === 'files' (see gotoFolder() below) --
    // any other screen's popstate is completely unaffected by this
    // addition (path defaults to '', same as before folders existed).
    const path = (screen === 'files' && e.state && typeof e.state.path === 'string') ? e.state.path : ''
    if (screen === 'files') {
      patchState({ currentPath: path, selectedIdx: -1 })
      // Explicit calls for the same no-op-when-unchanged reason as
      // enterFiles()'s own comment above -- e.g. Back from "Photos" to
      // "Files" when currentPath is already '' some other way.
      renderBreadcrumb()
      renderFileList()
    }
    setScreen(screen)
  })

  // state → DOM
  subscribe('screen', v => renderScreen(v))
  subscribe('accountReady', v => { r.readyDot.className = 'dot ' + (v ? 'on' : 'off') })
  subscribe('toast', v => { r.toast.textContent = v })
  subscribe('status', v => { r.statusText.textContent = v || '' })
  subscribe('busy', v => {
    const sf = selectedFile()
    r.btnDownload.disabled = v || !sf
    r.btnShare.disabled = v || !sf
    r.btnDelete.disabled = v || !sf
  })
  subscribe('files', () => { renderFileList(); updateTotals() })
  subscribe('currentPath', () => { renderFileList(); renderBreadcrumb() })
  subscribe('selectedIdx', () => {
    renderFileList()
    const sf = selectedFile()
    r.btnDownload.disabled = !sf || getState().busy
    r.btnShare.disabled = !sf || getState().busy
    r.btnDelete.disabled = !sf || getState().busy
    r.fileActions.classList.toggle('hidden', !sf)
  })
  subscribe('progress', v => {
    if (v) {
      r.progressWrap.classList.remove('hidden')
      // FIX (2026-09-14, "tessera-web-map-progress"): percent is NOT
      // painted here -- doUpload() already calls setProgressTarget(percent)
      // synchronously right before this patchState fires, which starts
      // (or updates) the ease-forward timer toward that same real value.
      // Rendering v.percent directly here too would jump the bar straight
      // to the target every tick and defeat the whole point of easing
      // between shard events. This subscriber only owns the label text
      // and the map pin -- renderProgressBar() is owned exclusively by
      // setProgressTarget()'s timer (plus the explicit 0%/100% calls in
      // doUpload at start/completion).
      r.progressLabel.textContent = v.stage + (v.elapsed ? ' \u00b7 ' + Math.round(v.elapsed / 1000) + 's' : '')
      if (v.hostKey) mapController && mapController.landedHost(v.hostKey)
    } else {
      r.progressWrap.classList.add('hidden')
    }
  })

  await doBoot()
}

// ── History API helpers ───────────────────────────────────
//
// goto() pushes a real history entry (a "real history step" per law --
// invite, request stub, password, words are each individually reachable
// via Back). replaceScreen() replaces the current entry instead -- used
// for the boot-time root screen (Welcome or latched Unlock, so there is
// no "back before the root") and for landing on Files after Ready
// ("replaceState so Back does not unwind create").

function goto(screen) {
  setScreen(screen)
  history.pushState({ screen }, '', '#' + screen)
}

function replaceScreen(screen) {
  setScreen(screen)
  history.replaceState({ screen }, '', '#' + screen)
}

// FOLDERS (2026-09-15, "tessera-web-folders-v1"): "Hash may be #files /
// #files/Photos / #files/Photos/Italy." gotoFolder() ALWAYS pushes a
// real history entry (entering a folder, or returning to root via a
// breadcrumb tap, are each individually reachable via Back -- same
// "real history step" rule goto() already uses for onboard screens).
// The screen itself never changes (always 'files') -- only currentPath
// and the URL hash move.
function gotoFolder(path) {
  patchState({ currentPath: path, selectedIdx: -1 })
  const hash = path ? '#files/' + path : '#files'
  history.pushState({ screen: 'files', path }, '', hash)
}

// ── screens ──────────────────────────────────────────────

function renderScreen(s) {
  r.welcomeScreen.classList.toggle('hidden', s !== 'welcome')
  r.inviteScreen.classList.toggle('hidden', s !== 'invite')
  r.requestStubScreen.classList.toggle('hidden', s !== 'requestStub')
  r.wordsScreen.classList.toggle('hidden', s !== 'words')
  r.setPasswordScreen.classList.toggle('hidden', s !== 'setPassword')
  r.readyWaitScreen.classList.toggle('hidden', s !== 'readyWait')
  r.recoverScreen.classList.toggle('hidden', s !== 'recover' && s !== 'recoverApproval')
  r.unlockScreen.classList.toggle('hidden', s !== 'unlock')
  r.filesScreen.classList.toggle('hidden', s !== 'files')
  r.filesLayout.classList.toggle('hidden', s !== 'files')
  r.header.classList.toggle('hidden', s === 'loading' || s === 'welcome')
}

// ── preload (background, never awaited by onboarding) ────
//
// LAW: "GET /hosts / hosts() occupies. Do not call it during onboarding
// or as a preload." getAccount()/waitForReady() below call sdk.account(),
// never sdk.hosts() -- confirmed by reading files.js: getAccount() is
// `sdk.account()` only. This function is fired once, right after first
// paint, and its own errors are swallowed -- Welcome must never wait on
// it, and a warm-up failure must never surface as a headline.
let _preloadStarted = false
function kickoffPreload() {
  if (_preloadStarted) return
  _preloadStarted = true
  // 1. wasm engine start, in the background. 'idx' fetch mode: Tessera
  //    Web's indexer calls route through this app's own same-origin
  //    /v2/tessera/web/idx/ nginx proxy (2026-09-14 "tessera-web-invite-fetch"
  //    fix -- see interceptor.js's MODE UPDATE comment for why 'direct'
  //    broke the invite-approval POST specifically).
  initSia('idx').catch(e => console.warn('[tessera-web] preload initSia failed:', e.message))
  // 2. warm the indexer proxy path with a harmless GET. Only meaningful
  //    once a real sdk exists (post-Unlock/Set-password reconnect) --
  //    with no sdk yet (fresh Welcome visit, no account attached), there
  //    is nothing to warm beyond the wasm start above, which is the
  //    actually expensive part. See enterFiles()'s own waitForReady()
  //    call, which is the same getAccount() path, not a duplicate.
}

// ── boot ─────────────────────────────────────────────────

async function doBoot() {
  kickoffPreload()  // fire-and-forget, after first paint

  // BOOT ORDER (packet law):
  //   tesseraweb wrapped vault -> Unlock
  //   else                     -> Welcome
  // Both are HISTORY ROOTS for this browser -- replaceScreen (not goto),
  // so there is no "Back before the root" and a latched browser's Unlock
  // is never one Back-tap away from being skipped.
  if (hasWrappedVault(PREFIX)) {
    r.unlockStatus.textContent = ''
    r.unlockPassword.value = ''
    replaceScreen('unlock')
  } else {
    replaceScreen('welcome')
  }
}

// ── create: invite ────────────────────────────────────────

function onShowInvite() {
  r.inviteInput.value = ''
  r.inviteStatus.textContent = ''
  goto('invite')
}

async function onInviteContinue() {
  const invite = r.inviteInput.value.trim()
  if (!invite) { r.inviteStatus.textContent = 'Please enter your invite.'; return }

  r.btnInviteContinue.disabled = true
  r.inviteStatus.textContent = 'Connecting\u2026'
  try {
    // In-page connect (2026-09-14 law: "No second tab. No 'use the invite
    // as the password.'"): the invite typed above IS the connect key,
    // submitted directly to the indexer's approval endpoint from here --
    // see connectWithInvite() in auth.js for the confirmed-live, no-Indexd-
    // edit mechanism. Routed through 'idx' (same-origin /v2/tessera/web/idx/
    // proxy) as of "tessera-web-invite-fetch" -- the approval POST's target
    // route has no CORS headers on index.dithr.dev directly, so 'direct'
    // mode's cross-origin call was failing preflight ("Failed to fetch").
    // If this ever stops working (proxy route removed, Indexd hardened),
    // it throws and the catch below shows the real error -- this path does
    // not fall back to a second tab.
    const { builder, appId, phrase } = await connectWithInvite(invite, PREFIX, 'idx')
    patchState({ builder, appId, phrase })
    r.inviteInput.value = ''
    r.inviteStatus.textContent = ''
    goToSetPassword('inviteRegister')
  } catch (e) {
    r.inviteStatus.textContent = 'Could not use that invite: ' + (e.message || 'Unknown error')
    r.btnInviteContinue.disabled = false
    console.error(e)
    return
  }
  r.btnInviteContinue.disabled = false
}

// ── create: request an invite (named stub, not designed) ─

function onShowRequestStub() {
  goto('requestStub')
}

// ── create: words ────────────────────────────────────────

function onWordsSaved() {
  r.wordsStatus.textContent = ''
  completeCreateAfterWords()
}

// ── create/recover: password ─────────────────────────────

// ORDER (2026-09-14 law): create is invite -> password -> words -> Ready
// -> Files (the shipped order was invite -> approve -> words -> password;
// this packet flips password and words). Password may be chosen before
// the account's real keys exist -- completeRegistration() (which derives
// the AppKey from the phrase) runs when the password screen is submitted,
// and the WRAP (setUnlockPassword) only runs after words are shown and
// confirmed, once the key definitely exists. Recover stays words ->
// password, unchanged.
let _passwordFlow = null  // 'inviteRegister' | 'recoverRegister'
let _pendingPassword = ''

function goToSetPassword(flow) {
  _passwordFlow = flow
  r.newPassword.value = ''
  r.newPasswordConfirm.value = ''
  r.setPasswordStatus.textContent = ''
  goto('setPassword')
}

async function onSetPassword() {
  const pw = r.newPassword.value
  if (!pw) { r.setPasswordStatus.textContent = 'Please enter a password.'; return }
  if (pw !== r.newPasswordConfirm.value) { r.setPasswordStatus.textContent = 'Passwords do not match.'; return }

  r.btnSetPassword.disabled = true
  r.setPasswordStatus.textContent = ''

  try {
    if (_passwordFlow === 'inviteRegister') {
      const { builder, phrase } = getState()
      if (!builder) throw new Error('Missing registration context.')
      // Do NOT show words until the phrase is real: complete registration
      // (derives + registers the AppKey from this exact phrase) right here,
      // so the words screen that follows is guaranteed to show the actual
      // working recovery phrase for a real, now-registered account -- not
      // a phrase generated before we knew registration would succeed.
      const sdk = await completeRegistration(builder, phrase, PREFIX)
      patchState({ sdk, builder: null })
      registerSdk(sdk)
      _pendingPassword = pw  // wrap happens after words are confirmed, once the key exists
      r.wordsText.textContent = phrase
      goto('words')
    } else if (_passwordFlow === 'recoverRegister') {
      const { sdk } = getState()
      if (!sdk) throw new Error('Missing recovery session.')
      await setUnlockPassword(pw, PREFIX)
      await initRelay()
      await enterFiles()
    } else {
      throw new Error('Unknown password flow.')
    }
  } catch (e) {
    r.setPasswordStatus.textContent = 'Could not set password: ' + (e.message || 'error')
    r.btnSetPassword.disabled = false
    console.error(e)
    return
  }
  r.btnSetPassword.disabled = false
}

// Runs after "I saved them" on the words screen (invite-register flow
// only -- recovery never shows words). Wraps the now-real AppKey with the
// password collected earlier, then proceeds to Ready -> Files.
async function completeCreateAfterWords() {
  goto('readyWait')
  r.readyWaitStatus.textContent = ''
  try {
    await setUnlockPassword(_pendingPassword, PREFIX)
    _pendingPassword = ''
    patchState({ phrase: '' })
    await initRelay()
    await enterFiles()
  } catch (e) {
    r.readyWaitStatus.textContent = 'Could not finish setup: ' + (e.message || 'error')
    console.error(e)
  }
}

// ── i have my words (recover) ────────────────────────────

function onShowRecover() {
  r.recoverPhraseInput.value = ''
  r.recoverStatus.textContent = ''
  goto('recover')
}

async function onRecoverContinue() {
  const phrase = r.recoverPhraseInput.value.trim()
  if (!phrase) { r.recoverStatus.textContent = 'Please enter your 12 words.'; return }
  if (phrase.split(/\s+/).length < 12) { r.recoverStatus.textContent = 'Please enter all 12 words.'; return }

  r.btnRecoverContinue.disabled = true
  r.recoverStatus.textContent = ''

  try {
    const result = await beginRecovery(phrase, msg => { r.recoverStatus.textContent = msg }, PREFIX, 'idx')

    if (!result.needsApproval) {
      patchState({ sdk: result.sdk, builder: null, phrase: '' })
      registerSdk(result.sdk)
      goToSetPassword('recoverRegister')
      return
    }

    // Rare edge case: this account needs re-approval before it can
    // reconnect (revoked / never fully registered). Tessera Web has no
    // "no second tab" exception for this -- the packet's ban is blanket,
    // and this path isn't in the proof scope (direct recovery, the branch
    // above, needs zero approval for a normal already-registered
    // account). Rather than opening a second tab or reusing Drop's
    // approval-link UI here, this fails with a clear, honest message and
    // leaves the customer on Recover -- no invented mechanism, no silent
    // fallback to the forbidden second-tab flow.
    throw new Error('This account needs to be re-approved. Contact support to continue.')
  } catch (e) {
    r.recoverStatus.textContent = 'Could not continue: ' + (e.message || 'Unknown error')
    r.btnRecoverContinue.disabled = false
    console.error(e)
  }
}

// ── unlock ───────────────────────────────────────────────

async function onUnlock() {
  const pw = r.unlockPassword.value
  if (!pw) { r.unlockStatus.textContent = 'Please enter your password.'; return }

  r.btnUnlock.disabled = true
  r.unlockStatus.textContent = ''

  try {
    const appKeyHex = await unwrapAppKey(pw, PREFIX)
    const { appId } = getSaved(PREFIX)
    const sdk = await reconnectWithAppKey(appId, appKeyHex, 'idx')
    if (!sdk) {
      // Wrong password or a stale/rejected key -- stay, do NOT delete
      // the vault, per law.
      r.unlockStatus.textContent = 'Wrong password.'
      r.btnUnlock.disabled = false
      return
    }
    patchState({ sdk })
    registerSdk(sdk)
    await initRelay()
    r.unlockPassword.value = ''
    await enterFiles()
  } catch (e) {
    // unwrapAppKey throws on a wrong password too (AES-GCM auth-tag
    // mismatch) -- same "stay on Unlock, vault untouched" outcome.
    r.unlockStatus.textContent = 'Wrong password.'
    r.btnUnlock.disabled = false
    console.error(e)
  }
}

function onForgotPassword() {
  onShowRecover()
}

// ── files ────────────────────────────────────────────────

async function enterFiles() {
  // replaceScreen, not goto (packet law: "After Ready lands on Files,
  // replaceState so Back does not unwind create or clear tesseraweb.*").
  // FOLDERS (2026-09-15, "tessera-web-folders-v1"): always lands at
  // root on a fresh entry into Files (Unlock, Ready, or first boot) --
  // currentPath is reset here, not carried over from any prior session
  // state, so unlocking never silently re-opens whatever folder was
  // open when the browser was last locked.
  patchState({ currentPath: '' })
  renderBreadcrumb()  // explicit call: patchState() above is a no-op when
                       // currentPath is already '' (the store's own default),
                       // so the 'currentPath' subscriber would never fire on
                       // a fresh boot -- this guarantees the breadcrumb is
                       // painted regardless.
  replaceScreen('files')
  const sdk = getState().sdk

  // FIX (2026-09-14, "tessera-web-add-relay"): status used to stay on
  // "Checking account..." until waitForReady(sdk) resolved -- which polls
  // every 5s for up to 5 minutes. The Files screen (and its Add dropzone)
  // is already rendered and clickable the instant replaceScreen() above
  // runs, so that status line was sitting there stale/misleading long
  // after the add box was usable -- exactly the "stuck Connecting" the
  // packet calls out. Clear it immediately; run the real account-ready
  // check and file list load in the background instead of gating on it.
  patchState({ status: '' })
  refreshFiles().catch(e => console.warn('[tessera-web] initial file list load failed:', e.message))

  try {
    await waitForReady(sdk)
    const acct = await getAccount(sdk)
    patchState({ accountReady: !!acct.ready })
  } catch (e) {
    // Account-ready is only the header dot indicator now -- files already
    // loaded via the background refreshFiles() call above and Add already
    // works via the WASM fallback regardless of this promise's outcome.
    // Don't overwrite status with a scary "Could not load files" here; that
    // used to reintroduce a stuck-looking status line if this hangs (up to
    // 5 minutes) and then fails. Log only.
    console.warn('[tessera-web] account-ready check failed:', e.message)
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

// FOLDERS (2026-09-15, "tessera-web-folders-v1"): "Folder rows sit
// above file rows in the current place. Click a folder -> enter it."
// `files` in state stays the SDK's full flat list (folder-agnostic --
// selectedIdx/selectedFile() in store.js are unchanged and still index
// into that same full array); this function only changes what's
// RENDERED, filtering + splitting via computeFolderView() for the
// current currentPath. A visible file row still maps back to its real
// index in the full `files` array (via id lookup) so selection/
// Download/Share/Delete keep working exactly as before -- folders add
// a filtering layer on top, not a second selection model.
function renderFileList() {
  const { files, selectedIdx, currentPath } = getState()
  r.fileList.innerHTML = ''
  const { folders, files: fileRows } = computeFolderView(files, currentPath)

  if (!folders.length && !fileRows.length) {
    // COPY (2026-09-15, "tessera-web-look-v1", extended 2026-09-15
    // "tessera-web-folders-v1"): root empty copy stays "No files yet.";
    // an empty folder gets its own exact string, "This folder is
    // empty."
    const emptyCopy = currentPath ? 'This folder is empty.' : 'No files yet.'
    r.fileList.innerHTML =
      '<div class="empty-state"><div class="empty-title">' + esc(emptyCopy) + '</div></div>'
    return
  }

  for (const folder of folders) {
    const row = document.createElement('div')
    row.className = 'file-row folder-row'
    row.innerHTML =
      '<div class="file-info">' +
        '<span class="folder-icon">\u{1F4C1}</span>' +
        '<span class="file-name">' + esc(folder.name) + '</span>' +
      '</div>' +
      '<button class="btn btn-ghost btn-folder-delete" title="Delete folder" data-path="' + esc(folder.path) + '">\u{1F5D1}\uFE0F</button>'
    row.querySelector('.file-info').addEventListener('click', () => gotoFolder(folder.path))
    // FOLDERS (2026-09-15, "tessera-web-folders-v1"): folder rows are
    // never "selected" the way file rows are (clicking a folder row's
    // own info area navigates INTO it, per "Click a folder -> enter
    // it") -- so Delete needs its OWN small affordance directly on the
    // row rather than sharing the file-selection + bottom Delete
    // button flow. stopPropagation so this click never also bubbles
    // into the row's own navigate-in handler above.
    row.querySelector('.btn-folder-delete').addEventListener('click', (e) => {
      e.stopPropagation()
      onDeleteFolder(folder.path, folder.name)
    })
    r.fileList.appendChild(row)
  }

  for (const f of fileRows) {
    const realIdx = files.findIndex(x => x.id === f.id)
    const row = document.createElement('div')
    row.className = 'file-row' + (realIdx === selectedIdx ? ' selected' : '')
    row.innerHTML =
      '<div class="file-info">' +
        '<span class="file-name">' + esc(f.displayName) + '</span>' +
        '<span class="file-meta">' + esc(fmtDateTime(f.updatedAt)) + '</span>' +
      '</div>' +
      '<span class="file-size">' + esc(formatBytes(f.size)) + '</span>'
    row.addEventListener('click', () => patchState({ selectedIdx: realIdx }))
    r.fileList.appendChild(row)
  }
}

// renderBreadcrumb(): "Files > Photos > Italy. Files is root. Each
// segment is a tap." Root is always rendered as the literal word
// "Files" (never blank), per the packet's own example.
function renderBreadcrumb() {
  const { currentPath } = getState()
  const segments = currentPath ? currentPath.split('/') : []
  let html = '<span class="breadcrumb-seg" data-path="">Files</span>'
  let acc = ''
  for (const seg of segments) {
    acc = acc ? acc + '/' + seg : seg
    html += '<span class="breadcrumb-sep">\u203a</span>' +
      '<span class="breadcrumb-seg" data-path="' + esc(acc) + '">' + esc(seg) + '</span>'
  }
  r.breadcrumb.innerHTML = html
}

function onBreadcrumbClick(e) {
  const seg = e.target.closest('.breadcrumb-seg')
  if (!seg) return
  const path = seg.dataset.path || ''
  if (path === getState().currentPath) return  // tapping the current (last) segment is a no-op
  gotoFolder(path)
}

// onNewFolder(): "Control: New folder next to Add... Prompt for a
// name. Reject empty, /, ., ... Trim. Max 64 characters." Uses the
// native prompt() (same UI family as onDelete's confirm() below --
// look-v1 law: "no new icon font," no custom modal invented here).
// "Creating Photos/Italy also ensures Photos/ exists" -- true by
// construction: you can only reach the New-folder control for
// "Photos/Italy" by having already navigated INTO Photos, which
// itself required Photos/ to already exist (either as a marker or
// because Photos already had files) -- so there is nothing extra to
// ensure here beyond pinning the new segment's own marker.
async function onNewFolder() {
  const sdk = getState().sdk; if (!sdk) return
  const raw = prompt('New folder name:')
  if (raw === null) return  // cancelled
  const { ok, error, name } = validateFolderName(raw)
  if (!ok) { showToast(error); return }
  const { currentPath, files } = getState()
  const path = buildPath(currentPath, name)
  // Refuse a duplicate folder name at this level outright (same
  // "no (1)/(2)" law as files -- this packet's own law says "do not
  // implement duplicate (1)/(2) in this packet," which cuts both ways:
  // don't invent de-duplication suffixes for folders either).
  const { folders: existingFolders } = computeFolderView(files, currentPath)
  if (existingFolders.some(f => f.name === name)) {
    showToast('A folder named "' + name + '" already exists here.')
    return
  }
  setBusy(true)
  try {
    await createFolderMarker(sdk, path)
    await refreshFiles()
    showToast('\u{1F4C1} Folder created: ' + name)
  } catch (e) {
    // "If a zero-byte pin is refused, print BLOCKED with the error and
    // still ship navigation + prefix-on-upload against folders that
    // already have a file." -- this is the live per-click failure
    // mode of that same case; the BLOCKED print itself belongs in this
    // packet's own written Output/report, not the UI, so the customer
    // just sees one quiet sentence like every other failure path here.
    showToast('Could not create that folder. Try again.')
    console.error(e)
  } finally { setBusy(false) }
}

function onFilePicked() {
  const f = r.fileInput.files && r.fileInput.files[0]
  r.fileInput.value = ''
  if (f) enqueueUpload(f)
}

// FIX (2026-09-14, "tessera-web-upload-hang"): "Files are a queue. One
// object at a time. Drop-while-busy enqueues. It does not start a second
// upload. It does not call hosts() for the waiter." A second drop used to
// call doUpload() directly, same as the first -- two concurrent
// sdk.upload() calls, each independently driving the wasm SDK's own host
// selection/occupancy. Now every drop goes through this queue; only the
// front of the queue is ever an active upload, and a queued file makes NO
// SDK call (no hosts(), no upload()) until it's actually its turn.
let _uploadQueue = []
let _uploadActive = false

function enqueueUpload(file) {
  _uploadQueue.push(file)
  if (_uploadQueue.length > 1) {
    showToast('\u23F3 Queued: ' + file.name + ' (waiting for current upload)')
  }
  processUploadQueue()
}

async function processUploadQueue() {
  if (_uploadActive) return
  const file = _uploadQueue.shift()
  if (!file) return
  _uploadActive = true
  try {
    await doUpload(file)
  } finally {
    _uploadActive = false
    // Next queued file (if any) only starts now -- no parallel uploads,
    // no extra hosts() call fired just because something is waiting.
    processUploadQueue()
  }
}

// ── upload map (2026-09-14, "tessera-web-map-progress") ─
//
// Lazily created on first Add so the map's CDN assets (topojson,
// topojson-client) and geo.json only ever load once an upload actually
// starts -- never on preload, never on boot. Kept as a stable module-
// level reference (not re-created per upload) so seenHosts/marks reset
// via mapController.reset() at the start of each upload instead of
// tearing down and rebuilding the canvas every time.
let mapController = null
let mapShown = false

function ensureMapController() {
  if (!mapController) mapController = createUploadMap(r.mapCanvas)
  return mapController
}

function showMap() {
  ensureMapController()
  r.filesScreen.classList.add('files-narrow')
  r.mapPane.classList.remove('hidden')
  r.btnShowMap.classList.add('hidden')
  mapShown = true
}

function hideMap() {
  r.filesScreen.classList.remove('files-narrow')
  r.mapPane.classList.add('hidden')
  // Only offer "Show map" again if this browser has actually seen a map
  // this session (btnShowMap stays hidden before the first Add ever
  // shows one) -- "one pair of controls, no third layout."
  if (mapController) r.btnShowMap.classList.remove('hidden')
  mapShown = false
}

// ── steady progress: interpolate between real shard ticks ─
//
// LAW: "Between ticks, the bar eases forward. It must never pass the
// next real shard percent. It must never hit 100% before pinObject
// returns. On fail, freeze and show the fail line." This is the ONLY
// place percent is eased -- onShardUploaded's own tick() call in
// files.js still drives the real target; this timer only interpolates
// the LAST TWO real values it was given, and is killed immediately on
// completion or failure so it can never run past what actually happened.
let _easeTimer = null
let _easeFrom = 0
let _easeTo = 0
let _easeStart = 0
const EASE_MS = 1800  // slightly under typical inter-shard gap; never overshoots because _easeTo is always the last REAL target

function renderProgressBar(pct) {
  r.progressFill.style.width = pct + '%'
}

function stopEase() {
  if (_easeTimer) { clearInterval(_easeTimer); _easeTimer = null }
}

function setProgressTarget(pct) {
  stopEase()
  _easeFrom = parseFloat(r.progressFill.style.width) || 0
  _easeTo = pct
  _easeStart = Date.now()
  if (_easeTo <= _easeFrom) { renderProgressBar(_easeTo); return }
  _easeTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - _easeStart) / EASE_MS)
    // ease-out: fast at first, settling just short of the target so a
    // slow shard never makes the bar look "done" before the real tick
    // arrives. Capped at _easeTo - 0.5 until the NEXT real tick calls
    // setProgressTarget again (or completion explicitly sets exactly 100).
    const eased = _easeFrom + (_easeTo - _easeFrom) * (1 - Math.pow(1 - t, 2))
    renderProgressBar(Math.min(eased, _easeTo - (t < 1 ? 0.5 : 0)))
    if (t >= 1) stopEase()
  }, 80)
}

async function doUpload(file) {
  const sdk = getState().sdk; if (!sdk) return
  setBusy(true)
  if (mapController) mapController.reset()
  showMap()
  stopEase()
  renderProgressBar(0)
  patchState({ status: '', progress: { stage: 'Preparing\u2026', percent: 0, elapsed: 0 } })
  try {
    await waitForReady(sdk)
    // FIX (2026-09-14, "tessera-web-occupy-fade"): REMOVED. The extra
    // sdk.hosts({limit:60}) call the "tessera-web-map-30" packet added
    // here (for the Add-start candidate preview) is a SECOND, real
    // GET /hosts occupy on top of whatever sdk.upload() below already
    // does internally -- confirmed live and directly, not by inference:
    // live fleet.served_windows showed 1056 undecremented rows for one
    // single customer pubkey, produced by calls firing 200-400ms apart
    // over about 90 seconds, each occupying 33 real hosts, with zero
    // matching pins ever landing for any of them (that pubkey traces to
    // this task's own repeated live verification sdk.hosts() calls
    // across the prior three map packets, made worse specifically by
    // this Add-start call being on the SAME account and firing on every
    // single Add). "One fetch if the write needs it anyway; share it"
    // assumed sdk.upload()'s internal host resolution and this call
    // were the SAME fetch -- they are not: sdk.upload()'s own
    // UploadOptions has no host-list parameter to receive this
    // result (confirmed via sia_storage_wasm.d.ts, same finding as
    // the prior packet), so this call could only ever be additional,
    // never shared. Per this packet's law ("remove it unless you can
    // prove it is the same fetch the write already needs and does not
    // double-increment") -- it could not be proven, so it is removed.
    // showCandidates() in map.js is now dead code (no caller) -- left
    // in place rather than deleted, since a future packet may restore
    // an Add-start preview through a genuinely shared signal; not
    // removing working code outside this packet's asked-for scope.
    // FOLDERS (2026-09-15, "tessera-web-folders-v1"): "Add while inside
    // a folder writes currentPath + file.name into metadata." The 4th
    // arg is uploadFile()'s new optional metaName -- omitted (root)
    // means the exact same call shape as before this packet.
    const { currentPath } = getState()
    const metaName = currentPath ? buildPath(currentPath, file.name) : undefined
    await uploadFile(sdk, file, ({ stage, percent, elapsed, hostKey }) => {
      // Real target only -- setProgressTarget's own ease-out never passes
      // this value (see EASE_MS comment above). The 'done' tick still
      // sets exactly 100, but only files.js ever calls that, after
      // pinObject() has already returned -- never this eased path.
      setProgressTarget(percent)
      patchState({ progress: { stage, percent, elapsed, hostKey } })
    }, metaName)
    stopEase()
    renderProgressBar(100)
    patchState({ progress: null })
    // "Do not clear the landed points when the bar hits 100%." --
    // completeWrite() starts the arc fade-out; it does NOT clear
    // landed/destination or origin glows. Only the NEXT upload's
    // reset() clears them.
    if (mapController) mapController.completeWrite()
    showToast('\u2705 ' + file.name + ' added')
    await refreshFiles()
  } catch (e) {
    // "On fail, freeze and show the fail line." -- stop any in-flight
    // ease immediately so the bar does not keep creeping toward a shard
    // count that will never arrive; the exact frozen percent stays
    // visible under the fail text until the next upload starts.
    stopEase()
    // COPY (2026-09-15, "tessera-web-look-v1"): "Add failed: one
    // sentence + try again. No stack trace." Was 'Add failed: ' +
    // e.message, which could surface a raw SDK/network error string
    // (a de-facto stack trace to a non-technical reader). One quiet,
    // fixed sentence now -- the real e is still logged to console
    // below for debugging, just never shown in the UI.
    patchState({ progress: null, status: 'Could not add this file. Try again.' })
    // FIX (2026-09-14, "tessera-web-occupy-fade"): "completeWrite() (or
    // equivalent) runs when uploadFile resolves OR REJECTS. Arcs fade.
    // A hung Add must not leave gold lines forever." Previously only
    // called on the success path -- a failed/thrown upload left every
    // traveling arc drawn at full brightness indefinitely (no fade,
    // no promotion to the quieter landed state). Now called in both
    // branches; on the fail path this also means any partial landed
    // destinations from shards that DID complete before the failure
    // keep their glow (per the "destination glow stays" rule, which
    // completeWrite() already respects unconditionally), while only
    // the arc LINES fade -- consistent with a successful completion.
    if (mapController) mapController.completeWrite()
    console.error(e)
  } finally { setBusy(false) }
}

async function onDownload() {
  const sf = selectedFile(); if (!sf) return
  const sdk = getState().sdk; if (!sdk) return
  setBusy(true); patchState({ status: 'Downloading\u2026' })
  // MAP INBOUND HOOK (2026-09-15, "tessera-web-look-v1"): shows the map
  // and feeds it downloadToDisk's onShardDownloaded events, same
  // pattern doUpload uses for onShardUploaded -- landedHost's second
  // argument is the direction flag ('download'), defaulting to the
  // existing 'upload'/gold behavior when omitted so doUpload's own
  // call site (unchanged) keeps drawing gold outbound arcs exactly as
  // before. No hosts() call added here -- this only listens to shard
  // events the download was already making.
  if (mapController) mapController.reset()
  showMap()
  try {
    await downloadToDisk(sdk, sf.id, sf.name, ({ hostKey, direction }) => {
      if (mapController && hostKey) mapController.landedHost(hostKey, direction)
    })
    if (mapController) mapController.completeWrite()
    showToast('\u2B07\uFE0F Downloaded: ' + sf.name)
    patchState({ status: '' })
  } catch (e) {
    if (mapController) mapController.completeWrite()
    // COPY (2026-09-15, "tessera-web-look-v1"): same "no stack trace"
    // treatment as Add failed -- one quiet sentence, real error only
    // to console.
    patchState({ status: 'Could not download this file. Try again.' })
    console.error(e)
  } finally { setBusy(false) }
}

async function onDelete() {
  const sf = selectedFile(); if (!sf) return
  const sdk = getState().sdk; if (!sdk) return
  if (!confirm('Delete "' + sf.name + '"?\n\nThis cannot be undone.')) return
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

// onDeleteFolder(path, name): "Delete on an empty folder deletes its
// marker only. Delete on a folder that has files: refuse with one
// sentence ('This folder has files.'). Do not mass-delete. Do not
// recurse." isNonEmptyFolder() itself DOES recurse (read-only) to
// answer that question correctly for nested content -- see its own
// comment in files.js -- but this function never deletes more than
// the single marker object either way.
async function onDeleteFolder(path, name) {
  const sdk = getState().sdk; if (!sdk) return
  const { files } = getState()
  if (isNonEmptyFolder(files, path)) {
    showToast('This folder has files.')
    return
  }
  const markerId = findFolderMarkerId(files, path)
  if (!markerId) {
    // Should not happen (a folder row only exists because SOMETHING
    // under this path exists, and isNonEmptyFolder() above already
    // confirmed it isn't a real file) -- but never silently no-op a
    // Delete click.
    showToast('Could not find that folder\u2019s marker.')
    return
  }
  if (!confirm('Delete "' + name + '"?\n\nThis cannot be undone.')) return
  setBusy(true); patchState({ status: 'Deleting\u2026' })
  try {
    await deleteFile(sdk, markerId)
    showToast('\u{1F5D1}\uFE0F Deleted: ' + name)
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
  } catch (e) { showToast('Could not create share link'); console.error(e) }
}

function closeShareModal() { r.shareModal.classList.add('hidden') }

async function onCopyLink() {
  try { await navigator.clipboard.writeText(r.shareLink.value) } catch (_) {
    r.shareLink.select(); r.shareLink.setSelectionRange(0, 99999); document.execCommand('copy')
  }
  showToast('\u{1F4CB} Link copied')
  closeShareModal()
}

// ── lock / remove from this browser ──────────────────────
//
// Lock = drop sdk from memory, keep wrapped vault, next visit Unlock.
// Remove from this browser = delete tesseraweb.*, next visit Welcome.
// Two DIFFERENT buttons/actions, per law -- not a single confirm-toggle.

function onLock() {
  patchState({
    sdk: null, accountReady: false,
    files: [], selectedIdx: -1, totals: { count: 0, totalBytes: 0 },
    builder: null, phrase: '', status: '', progress: null,
  })
  doBoot()
}

function onRemoveBrowser() {
  if (!confirm('Remove Tessera from this browser? You will need your 12 words to come back.')) return
  clearCredentials(PREFIX)
  patchState({
    sdk: null, accountReady: false,
    files: [], selectedIdx: -1, totals: { count: 0, totalBytes: 0 },
    builder: null, phrase: '', status: '', progress: null,
  })
  doBoot()
}
