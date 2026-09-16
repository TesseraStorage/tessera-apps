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
  isNonEmptyFolder, findFolderMarkerId,
  getVirtualFolders, addVirtualFolder,
  computeAllFolderPaths, existingBasenamesInFolder, resolveCollisionName,
  validateRenameName, renameObjectPath,
  getMapShards, addMapShard,
  getMapShownPref, setMapShownPref,
  filesUnderFolder, countFilesUnderFolder, renameFilePath,
  validateFolderRenameName, renameVirtualFolderPrefix, removeVirtualFolderPrefix,
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
    'btnDownload', 'btnShare', 'btnDelete',
    'btnMove', 'btnRename', 'btnCancelSelection',
    'btnNewFolder', 'breadcrumb', 'newFolderInline', 'newFolderInput',
    'btnNewFolderConfirm', 'btnNewFolderCancel',
    'filesLayout', 'btnShowMap', 'mapPane', 'btnHideMap', 'mapCanvas',
    'statusText', 'progressWrap', 'progressFill', 'progressLabel',
    'shareModal', 'shareLink', 'btnCopyLink', 'btnCloseModal',
    'textInputModal', 'textInputTitle', 'textInputField', 'textInputError',
    'btnTextInputConfirm', 'btnTextInputCancel',
    'moveModal', 'moveModalList', 'btnMoveCancel',
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
           placement on the map pane -- "same pair as Hide map."
           ALWAYS VISIBLE BY DEFAULT (2026-09-16, "tessera-web-handoff
           adjustments", REVISES the prior "starts hidden until a map
           has existed" law): "Show/hide link is always shown... on
           first visit, initial state is hidden w/ the link shown."
           No 'hidden' class on this button anymore -- enterFiles()'s
           preference-restore logic (web-ui.js) is the only thing that
           ever swaps it for #btnHideMap now, never boot-time CSS. -->
      <button id="btnShowMap" class="btn btn-ghost btn-show-map">Show map</button>
      <!-- HIDE MAP MOVED (operator, 2026-09-15): "Instead of 'Hide map'
           being in the map pane, put it top right of file pane (where
           'Show map' is shown when map isn't)." Both buttons now live
           in the SAME top-right corner slot of #filesScreen
           (.btn-show-map's own absolute position) -- showMap()/
           hideMap() toggle which ONE of the two is visible, so they
           never overlap. Starts hidden (the map itself starts hidden
           by default -- see btnShowMap's own comment above). -->
      <button id="btnHideMap" class="btn btn-ghost btn-show-map hidden">Hide map</button>
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
      <!-- NEW FOLDER INLINE FIELD (Apple A, 2026-09-16): "In-page name
           field in the current place. Not window.prompt." Hidden by
           default; onNewFolder() shows it and focuses the input instead
           of calling prompt(). Same look family as other inline inputs
           (.new-folder-inline reuses the standard input[type=text] +
           .btn styles, no new component). -->
      <div id="newFolderInline" class="new-folder-inline hidden">
        <input type="text" id="newFolderInput" placeholder="Folder name" autocomplete="off" maxlength="64">
        <button id="btnNewFolderConfirm" class="btn btn-primary">Create</button>
        <button id="btnNewFolderCancel" class="btn btn-ghost">Cancel</button>
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
        <button id="btnMove" class="btn" disabled>Move</button>
        <button id="btnRename" class="btn" disabled>Rename</button>
        <button id="btnDelete" class="btn btn-danger" disabled>Delete</button>
        <button id="btnCancelSelection" class="btn btn-ghost">Cancel</button>
      </div>
      <p id="statusText" class="status-text"></p>
    </section>

    <aside id="mapPane" class="map-pane hidden">
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

  <!-- RENAME MODAL (Apple A, 2026-09-16): "In-page name. Same collision
       rule in the current folder. Metadata only. No re-upload." Reuses
       the same modal-card look as Share -- no new component family. -->
  <div id="textInputModal" class="modal-overlay hidden">
    <div class="modal-card">
      <h3 id="textInputTitle">Rename</h3>
      <input type="text" id="textInputField" autocomplete="off">
      <p id="textInputError" class="status-text"></p>
      <div class="modal-buttons">
        <button id="btnTextInputConfirm" class="btn btn-primary">Rename</button>
        <button id="btnTextInputCancel" class="btn btn-ghost">Cancel</button>
      </div>
    </div>
  </div>

  <!-- MOVE MODAL (Apple A, 2026-09-16): "Move -> pick Root or a folder
       that already exists (virtual or inferred)." A flat list of every
       known folder path plus Root -- no tree widget invented, matching
       the packet's own "existing row select is fine" framing for the
       source file. -->
  <div id="moveModal" class="modal-overlay hidden">
    <div class="modal-card">
      <h3>Move to&hellip;</h3>
      <div id="moveModalList" class="move-modal-list"></div>
      <div class="modal-buttons">
        <button id="btnMoveCancel" class="btn btn-ghost">Cancel</button>
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
  r.btnHideMap.addEventListener('click', hideMap)
  r.btnShowMap.addEventListener('click', showMap)
  r.btnNewFolder.addEventListener('click', onNewFolder)
  r.btnNewFolderConfirm.addEventListener('click', onNewFolderConfirm)
  r.btnNewFolderCancel.addEventListener('click', onNewFolderCancel)
  r.newFolderInput.addEventListener('keydown', e => { if (e.key === 'Enter') onNewFolderConfirm() })
  r.btnMove.addEventListener('click', onMove)
  r.btnMoveCancel.addEventListener('click', closeMoveModal)
  r.btnRename.addEventListener('click', onRename)
  r.btnTextInputConfirm.addEventListener('click', onTextInputConfirm)
  r.btnTextInputCancel.addEventListener('click', closeTextInputModal)
  r.textInputField.addEventListener('keydown', e => { if (e.key === 'Enter') onTextInputConfirm() })
  r.breadcrumb.addEventListener('click', onBreadcrumbClick)

  r.dropzone.addEventListener('click', () => r.fileInput.click())
  r.fileInput.addEventListener('change', onFilePicked)
  r.btnDownload.addEventListener('click', onDownload)
  r.btnDelete.addEventListener('click', onDelete)
  r.btnShare.addEventListener('click', onShare)
  r.btnCloseModal.addEventListener('click', closeShareModal)
  r.btnCopyLink.addEventListener('click', onCopyLink)

  // CANCEL SELECTION (2026-09-16, per operator instruction: "the file
  // options menu doesn't have a cancel button... clicking anywhere
  // else on the screen should also mean cancel"). Deselecting is
  // already exactly what popstate/gotoFolder/refreshFiles do elsewhere
  // in this file (patchState({ selectedIdx: -1 })) -- reused verbatim,
  // no new selection-clearing mechanism invented.
  r.btnCancelSelection.addEventListener('click', () => patchState({ selectedIdx: -1 }))
  // Click-anywhere-else-cancels: a capturing document click listener,
  // not a click-outside library -- if the click landed inside a file
  // row (which already owns its own select-this-row click handler) or
  // inside the actions bar itself (Download/Share/Move/Rename/Delete/
  // Cancel all have their own handlers that must run first, unbothered
  // by this), do nothing. Any other click on the page, while a row is
  // selected, deselects. Modals (Share/Move/Rename text input) are
  // portal-like overlays layered OVER this same document, so a click
  // on a modal's own content must NOT also cancel the file selection
  // underneath it -- excluded explicitly via .closest() checks below,
  // same reasoning as the file-row/actions-bar exclusions.
  document.addEventListener('click', (e) => {
    if (getState().selectedIdx === -1) return
    if (e.target.closest('.file-row')) return
    if (e.target.closest('#fileActions')) return
    if (e.target.closest('.modal-overlay')) return
    patchState({ selectedIdx: -1 })
  })

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
    r.btnMove.disabled = v || !sf
    r.btnRename.disabled = v || !sf
    r.btnDelete.disabled = v || !sf
  })
  subscribe('files', () => { renderFileList(); updateTotals() })
  subscribe('currentPath', () => { renderFileList(); renderBreadcrumb() })
  subscribe('selectedIdx', () => {
    renderFileList()
    const sf = selectedFile()
    r.btnDownload.disabled = !sf || getState().busy
    r.btnShare.disabled = !sf || getState().busy
    r.btnMove.disabled = !sf || getState().busy
    r.btnRename.disabled = !sf || getState().busy
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
      // LINE LIFETIME (2026-09-16, "tessera-web-encode-hold",
      // SIMPLIFIED FINAL): map.js's shardLanded()/landedHost() no
      // longer uses transferMs for line timing at all -- every line
      // now lasts a flat LINE_FLOOR_MS (4s) from landing, full stop.
      // v.transferMs is still threaded through here unchanged (still
      // useful as ShardProgress.elapsedMs for any future caller), just
      // no longer READ by map.js's fade logic.
      if (v.hostKey) mapController && mapController.landedHost(v.hostKey, undefined, v.transferMs)
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
  // VIEWPORT-CLAMPED PANEL (2026-09-16, "tessera-web-handoff
  // adjustments" bug report): re-measure every time Files becomes the
  // visible screen -- the panel was display:none an instant ago, so
  // its own getBoundingClientRect().top is only meaningful right after
  // it's back in the render tree.
  if (s === 'files') clampFilesPanelHeight()
}

// clampFilesPanelHeight(): "The entire visible, scrollable list should
// be contained within the files pane, which should not extend off the
// page." #filesScreen's CSS rule (style.css, #filesLayout
// .column-screen) makes it a column flexbox with #fileList as the one
// growing/shrinking child -- this function only supplies the actual
// max-height NUMBER, via a real getBoundingClientRect() measurement
// (the panel's top offset moves with header wrap state and viewport
// width, so a static calc() in CSS can't answer this correctly -- same
// reasoning map.js's own ResizeObserver uses for the canvas). Leaves
// an 18px breathing gap below the panel's own bottom edge to the
// viewport bottom, matching this file's existing panel margins
// (14px bottom margin + a few px, not a bespoke new number).
function clampFilesPanelHeight() {
  if (!r.filesScreen || r.filesScreen.classList.contains('hidden')) return
  const top = r.filesScreen.getBoundingClientRect().top
  const maxH = Math.max(200, window.innerHeight - top - 18)
  r.filesScreen.style.maxHeight = maxH + 'px'
}
window.addEventListener('resize', clampFilesPanelHeight)

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

  // BACKGROUND MAP PRELOAD (2026-09-16, "tessera-web-handoff
  // adjustments"): "When a user arrives on the files page, the map's
  // shard-cache should begin loading in the background. This way, it
  // does not cause a delay in later display of data, nor a delay in
  // getting the files' page's other items to load." ensureMapController()
  // creates the canvas controller and kicks off its own async init()
  // (CDN topojson scripts + geo.json fetch, see map.js) and seeds it
  // from the persisted mapshards records -- all of that already
  // happens off the main synchronous path (init() is async, seedPins()
  // is synchronous localStorage-only and cheap). Firing it here, NOT
  // awaited, means it's warm by the time the user's first Add or first
  // "Show map" click needs it, without blocking refreshFiles() or
  // anything else on this screen. Previously this only ever ran lazily
  // on first Add or first manual "Show map" click.
  ensureMapController()
  // MAP SHOW/HIDE PREFERENCE (2026-09-16, "tessera-web-handoff
  // adjustments"): "On first visit, initial state is hidden w/ the
  // link shown... If a user has chosen to hide map, then subsequent
  // activity should not change show/hide status." getMapShownPref()
  // returns null on a true first visit (no explicit preference ever
  // set) -- in that case we leave the map hidden (the default DOM
  // state already is) and do NOT call showMap()/hideMap() at all, so
  // btnShowMap/btnHideMap stay exactly as the SKELETON's own hidden
  // classes left them until doUpload()'s first-upload check (below)
  // decides whether to reveal "Show map". If the user has an explicit
  // prior preference (true or false, from a past visit's showMap()/
  // hideMap() click), that preference is restored here so it survives
  // a reload/relock -- entering Files must never silently reset it.
  {
    const pref = getMapShownPref()
    if (pref === true) showMap(false)
    else if (pref === false) hideMap(false)
  }

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
  // FOLDER-CREATE-FAIL FIX (2026-09-15): empty folders are now tracked
  // virtually (localStorage), not a pinned marker object -- see
  // files.js's own block comment for the confirmed root cause
  // (zero-byte upload always throws in the WASM SDK's erasure coder).
  // getVirtualFolders() is read fresh on every render rather than
  // cached in state -- it's synchronous localStorage, cheap, and this
  // keeps it trivially correct after New Folder / Delete without a
  // second piece of reactive state to keep in sync with `files`.
  const { folders, files: fileRows } = computeFolderView(files, currentPath, getVirtualFolders())

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
      '<button class="btn btn-ghost btn-folder-rename" title="Rename folder" data-path="' + esc(folder.path) + '">\u270F\uFE0F</button>' +
      '<button class="btn btn-ghost btn-folder-delete" title="Delete folder" data-path="' + esc(folder.path) + '">\u{1F5D1}\uFE0F</button>'
    row.querySelector('.file-info').addEventListener('click', () => gotoFolder(folder.path))
    // FOLDERS (2026-09-15, "tessera-web-folders-v1"): folder rows are
    // never "selected" the way file rows are (clicking a folder row's
    // own info area navigates INTO it, per "Click a folder -> enter
    // it") -- so Delete needs its OWN small affordance directly on the
    // row rather than sharing the file-selection + bottom Delete
    // button flow. stopPropagation so this click never also bubbles
    // into the row's own navigate-in handler above.
    // RENAME (Apple B, 2026-09-16): same own-affordance pattern as
    // Delete, right next to it -- folder rows have no "selected" state
    // to hang a shared bottom-bar Rename button off of.
    row.querySelector('.btn-folder-rename').addEventListener('click', (e) => {
      e.stopPropagation()
      onRenameFolder(folder.path, folder.name)
    })
    row.querySelector('.btn-folder-delete').addEventListener('click', (e) => {
      e.stopPropagation()
      onDeleteFolder(folder.path, folder.name)
    })
    // DROP TARGET (Apple A, 2026-09-16): "Drop an already-listed file
    // onto a folder row: same move, not a new upload." AND "Drop a
    // desktop File onto a folder row: Add into that folder." Both
    // land on this same row -- the drop handler below distinguishes
    // by dataTransfer contents (internal drag carries our own
    // text/x-tessera-file-id type; an OS drop carries real
    // e.dataTransfer.files).
    row.addEventListener('dragover', (e) => {
      e.preventDefault()
      row.classList.add('folder-drop-target')
    })
    row.addEventListener('dragleave', () => row.classList.remove('folder-drop-target'))
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      row.classList.remove('folder-drop-target')
      const osFiles = e.dataTransfer.files
      if (osFiles && osFiles.length) {
        // Desktop File dropped on a folder row: Add into that folder --
        // one occupy, same as Add, per law. enqueueUpload's own
        // metaName resolution already reads getState().currentPath at
        // upload time, so temporarily targeting this folder for the
        // single queued upload reuses the exact same Add path (no
        // second upload mechanism invented here).
        enqueueUploadIntoFolder(osFiles[0], folder.path)
        return
      }
      const draggedId = e.dataTransfer.getData('text/x-tessera-file-id')
      if (draggedId) moveFileTo(draggedId, folder.path)
    })
    r.fileList.appendChild(row)
  }

  for (const f of fileRows) {
    const realIdx = files.findIndex(x => x.id === f.id)
    const row = document.createElement('div')
    row.className = 'file-row' + (realIdx === selectedIdx ? ' selected' : '')
    row.draggable = true
    row.innerHTML =
      '<div class="file-info">' +
        '<span class="file-name">' + esc(f.displayName) + '</span>' +
        '<span class="file-meta">' + esc(fmtDateTime(f.updatedAt)) + '</span>' +
      '</div>' +
      '<span class="file-size">' + esc(formatBytes(f.size)) + '</span>'
    row.addEventListener('click', () => patchState({ selectedIdx: realIdx }))
    // DRAG SOURCE (Apple A, 2026-09-16): "Drop an already-listed file
    // onto a folder row: same move." Carries only the file's real id
    // (its own metadata.name full path is looked up fresh from state
    // in moveFileTo() at drop time, never trusted from a stale drag
    // payload) via a custom MIME type that no OS drag ever produces,
    // so the drop handler above can tell "our own row" apart from a
    // real desktop-file drop unambiguously.
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-tessera-file-id', f.id)
      e.dataTransfer.effectAllowed = 'move'
    })
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

// onNewFolder(): "Control: New folder next to Add... In-page name
// field in the current place. Not window.prompt. Reject empty, /, .,
// .. . Trim. Max 64 characters." (Apple A, 2026-09-16, REVISED from
// this packet's own "Homegrown 'folder is a label' is done" law --
// the prior window.prompt()-based implementation is exactly the thing
// this packet asks to stop doing.) Shows the inline field next to the
// New folder button instead of a native prompt; Cancel/blur/Escape
// close it with no side effect.
//
// FOLDER-CREATE-FAIL FIX (2026-09-15, "tessera-web-folder-create-fail"):
// no longer calls the SDK at all. The original design pinned a
// zero-byte marker object here, which always threw inside the WASM
// SDK's own erasure-coding step (confirmed root cause -- see files.js's
// block comment above FOLDER_MARKER_MIME) -- that is the exact "Could
// not create folder. Try again." toast the operator saw on every
// single retry. addVirtualFolder() is synchronous localStorage only:
// no upload, no pin, no await, nothing that can throw or hang, and no
// sdk needed at all (removed the sdk-missing early-return since
// there's no SDK call left to guard).
function onNewFolder() {
  r.newFolderInput.value = ''
  r.newFolderInline.classList.remove('hidden')
  r.newFolderInput.focus()
}

function onNewFolderCancel() {
  r.newFolderInline.classList.add('hidden')
  r.newFolderInput.value = ''
}

function onNewFolderConfirm() {
  const raw = r.newFolderInput.value
  const { ok, error, name } = validateFolderName(raw)
  if (!ok) { showToast(error); return }
  const { currentPath, files } = getState()
  const path = buildPath(currentPath, name)
  // Refuse a duplicate folder name at this level outright (same
  // "no (1)/(2)" law as files -- this packet's own law says "do not
  // implement duplicate (1)/(2) in this packet," which cuts both ways:
  // don't invent de-duplication suffixes for folders either).
  const { folders: existingFolders } = computeFolderView(files, currentPath, getVirtualFolders())
  if (existingFolders.some(f => f.name === name)) {
    showToast('A folder named "' + name + '" already exists here.')
    return
  }
  addVirtualFolder(path)
  onNewFolderCancel()
  renderFileList()
  showToast('\u{1F4C1} Folder created: ' + name)
}

function onFilePicked() {
  const f = r.fileInput.files && r.fileInput.files[0]
  r.fileInput.value = ''
  if (f) enqueueUpload(f)
}

// ── move / rename (Apple A, 2026-09-16) ──────────────────
//
// LAW: "Move is metadata only (updateMetadata + updateObjectMetadata).
// No second 10+20. No sdk.upload." renameObjectPath() in files.js
// makes exactly those two calls -- no hosts(), no upload(). Both Move
// and Rename funnel through the same collision-resolution +
// renameObjectPath() pair; they differ only in which piece of the
// full path changes (destination directory vs. basename).

let _moveTargetId = null  // file id the open Move modal is acting on

function onMove() {
  const sf = selectedFile(); if (!sf) return
  _moveTargetId = sf.id
  const { files } = getState()
  const allFolders = computeAllFolderPaths(files, getVirtualFolders())
  r.moveModalList.innerHTML = ''
  const rootRow = document.createElement('div')
  rootRow.className = 'move-modal-row'
  rootRow.textContent = 'Root'
  rootRow.addEventListener('click', () => { closeMoveModal(); moveFileTo(sf.id, '') })
  r.moveModalList.appendChild(rootRow)
  for (const path of allFolders) {
    const row = document.createElement('div')
    row.className = 'move-modal-row'
    row.textContent = path
    row.addEventListener('click', () => { closeMoveModal(); moveFileTo(sf.id, path) })
    r.moveModalList.appendChild(row)
  }
  r.moveModal.classList.remove('hidden')
}

function closeMoveModal() {
  r.moveModal.classList.add('hidden')
  _moveTargetId = null
}

// moveFileTo(objectId, destPath): "Rewrite metadata.name to
// dest/basename (or basename at Root). Then sdk.updateObjectMetadata.
// Stay in the current list after move (file disappears from here if
// dest is elsewhere)." No hosts() call (law: "hosts() on move: no").
// Collision rule applies at the DESTINATION, per "Applies to Move and
// to Add-into-folder and to Add at Root."
async function moveFileTo(objectId, destPath) {
  const sdk = getState().sdk; if (!sdk) return
  const { files } = getState()
  const src = files.find(f => f.id === objectId)
  if (!src) return
  const slashIdx = src.name.lastIndexOf('/')
  const basename = slashIdx === -1 ? src.name : src.name.slice(slashIdx + 1)
  const siblingNames = existingBasenamesInFolder(files, destPath, objectId)
  const finalBasename = resolveCollisionName(siblingNames, basename)
  const newFullName = buildPath(destPath, finalBasename)
  if (newFullName === src.name) return  // no-op move (same folder, same name)
  setBusy(true); patchState({ status: 'Moving\u2026' })
  try {
    await renameObjectPath(sdk, objectId, newFullName)
    await refreshFiles()
    patchState({ status: '' })
    showToast('\u{1F4C1} Moved: ' + finalBasename)
  } catch (e) {
    patchState({ status: 'Could not move this file. Try again.' })
    console.error(e)
  } finally { setBusy(false) }
}

// enqueueUploadIntoFolder(file, destPath): "Drop a desktop File onto a
// folder row: that is Add into that folder (prefix + existing upload
// path). One occupy, same as Add." Queued the same way as a normal
// Add drop, but tagging this entry with its own destPath so
// processUploadQueue()/doUpload() compute metaName against the
// FOLDER the file was dropped on, not whatever folder happens to be
// open in the list at the time its turn comes up.
function enqueueUploadIntoFolder(file, destPath) {
  _uploadQueue.push({ file, destPath })
  if (_uploadQueue.length > 1) {
    showToast('\u23F3 Queued: ' + file.name + ' (waiting for current upload)')
  }
  processUploadQueue()
}

function onRename() {
  const sf = selectedFile(); if (!sf) return
  const slashIdx = sf.name.lastIndexOf('/')
  const basename = slashIdx === -1 ? sf.name : sf.name.slice(slashIdx + 1)
  r.textInputTitle.textContent = 'Rename'
  r.btnTextInputConfirm.textContent = 'Rename'
  r.textInputField.value = basename
  r.textInputError.textContent = ''
  r.textInputModal.classList.remove('hidden')
  r.textInputField.focus()
  r.textInputField.select()
  _textInputMode = 'rename'
  _textInputTargetId = sf.id
}

// onRenameFolder(path, name): (Apple B, 2026-09-16) "In-page name
// (reuse the Rename field from Apple A)." Same modal/field as file
// Rename, a different mode value so onTextInputConfirm() below can
// branch into the folder-rewrite path instead of the single-object
// rename path. _textInputTargetPath carries the folder's OLD full
// path (not an object id -- a folder has no id of its own).
function onRenameFolder(path, name) {
  r.textInputTitle.textContent = 'Rename folder'
  r.btnTextInputConfirm.textContent = 'Rename'
  r.textInputField.value = name
  r.textInputError.textContent = ''
  r.textInputModal.classList.remove('hidden')
  r.textInputField.focus()
  r.textInputField.select()
  _textInputMode = 'renameFolder'
  _textInputTargetPath = path
}

let _textInputMode = null
let _textInputTargetId = null
let _textInputTargetPath = null

function closeTextInputModal() {
  r.textInputModal.classList.add('hidden')
  _textInputMode = null
  _textInputTargetId = null
  _textInputTargetPath = null
}

// onTextInputConfirm(): shared confirm handler for the Rename modal.
// "Same collision rule in the current folder. Metadata only. No
// re-upload." -- collision is checked against the file's OWN current
// folder (dirname of its existing metadata.name), never a typed path;
// the input field only ever edits the basename (validateRenameName
// rejects any "/" outright, same as New folder's segment rule).
async function onTextInputConfirm() {
  if (_textInputMode === 'renameFolder') { await onRenameFolderConfirm(); return }
  if (_textInputMode !== 'rename' || !_textInputTargetId) { closeTextInputModal(); return }
  const raw = r.textInputField.value
  const { ok, error, name } = validateRenameName(raw)
  if (!ok) { r.textInputError.textContent = error; return }
  const sdk = getState().sdk; if (!sdk) { closeTextInputModal(); return }
  const { files } = getState()
  const src = files.find(f => f.id === _textInputTargetId)
  if (!src) { closeTextInputModal(); return }
  const slashIdx = src.name.lastIndexOf('/')
  const dir = slashIdx === -1 ? '' : src.name.slice(0, slashIdx)
  const siblingNames = existingBasenamesInFolder(files, dir, src.id)
  const finalBasename = resolveCollisionName(siblingNames, name)
  const newFullName = buildPath(dir, finalBasename)
  closeTextInputModal()
  if (newFullName === src.name) return  // no-op rename
  setBusy(true); patchState({ status: 'Renaming\u2026' })
  try {
    await renameObjectPath(sdk, src.id, newFullName)
    await refreshFiles()
    patchState({ status: '' })
    showToast('\u270F\uFE0F Renamed: ' + finalBasename)
  } catch (e) {
    patchState({ status: 'Could not rename this file. Try again.' })
    console.error(e)
  } finally { setBusy(false) }
}

// onRenameFolderConfirm(): (Apple B, 2026-09-16) "Rewrite metadata.name
// on every object whose path is under the old prefix (Photos/... ->
// Travel/...). Nested stays nested. Update tesseraweb.folders virtual
// rows the same way. Metadata only. updateObjectMetadata per file. If
// N files is large, still do them. One status sentence: 'Renaming...'.
// No occupy."
//
// Collision check is against SIBLING FOLDERS at the same level (not
// sibling files -- "Collision with a sibling folder: refuse... Do not
// invent 'Photos (1)' for folders") -- computeFolderView() at the old
// folder's OWN parent directory gives exactly that sibling set, with
// the renaming folder's own current name excluded so it never
// collides against itself.
async function onRenameFolderConfirm() {
  const oldPath = _textInputTargetPath
  if (!oldPath) { closeTextInputModal(); return }
  const raw = r.textInputField.value
  const { files } = getState()
  const slashIdx = oldPath.lastIndexOf('/')
  const parentPath = slashIdx === -1 ? '' : oldPath.slice(0, slashIdx)
  const oldName = slashIdx === -1 ? oldPath : oldPath.slice(slashIdx + 1)
  const { folders: siblingFolders } = computeFolderView(files, parentPath, getVirtualFolders())
  const siblingNames = siblingFolders.map(f => f.name).filter(n => n !== oldName)
  const { ok, error, name } = validateFolderRenameName(raw, siblingNames)
  if (!ok) { r.textInputError.textContent = error; return }
  const newPath = buildPath(parentPath, name)
  closeTextInputModal()
  if (newPath === oldPath) return  // no-op rename
  const sdk = getState().sdk; if (!sdk) return
  const targets = filesUnderFolder(files, oldPath)
  setBusy(true); patchState({ status: 'Renaming\u2026' })
  try {
    // "Rewrite metadata.name on every object... Metadata only.
    // updateObjectMetadata per file." No sdk.upload(), no hosts() --
    // renameObjectPath() (Apple A) already makes exactly the two
    // calls the law names, reused verbatim per-file here.
    for (const f of targets) {
      const newFullName = renameFilePath(f.name, oldPath, newPath)
      await renameObjectPath(sdk, f.id, newFullName)
    }
    // Virtual (still-empty) rows under this folder move the same way
    // real objects do -- old path and any old/... children.
    renameVirtualFolderPrefix(oldPath, newPath)
    // If the browser is currently INSIDE the folder being renamed (or
    // a descendant of it), follow the rename -- staying on a path
    // string that no longer exists would silently show "This folder
    // is empty." even though the content just moved.
    const curPath = getState().currentPath
    const followedPath = (curPath === oldPath || curPath.startsWith(oldPath + '/'))
      ? newPath + curPath.slice(oldPath.length)
      : curPath
    await refreshFiles()
    patchState({ status: '', currentPath: followedPath })
    renderBreadcrumb()
    showToast('\u270F\uFE0F Renamed: ' + name)
  } catch (e) {
    patchState({ status: 'Could not rename this folder. Try again.' })
    console.error(e)
  } finally { setBusy(false) }
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
  _uploadQueue.push({ file, destPath: undefined })
  if (_uploadQueue.length > 1) {
    showToast('\u23F3 Queued: ' + file.name + ' (waiting for current upload)')
  }
  processUploadQueue()
}

async function processUploadQueue() {
  if (_uploadActive) return
  const item = _uploadQueue.shift()
  if (!item) return
  _uploadActive = true
  try {
    await doUpload(item.file, item.destPath)
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
  // PERSIST HOOK (2026-09-16, "tessera-web-add-hang-map400"): every
  // live landed shard with real geo also gets appended to
  // localStorage via addMapShard (files.js's own cap/trim -- see that
  // function's own comment for the 400-record limit). SEED (2026-09-16):
  // "On Files + map open, paint the stored pins before any new Add. No
  // network for that paint." -- seedPins() reads back what's already
  // in localStorage and draws it with zero network calls; only runs
  // ONCE, at controller creation (map is a stable module-level
  // reference per this file's own existing comment above), never
  // re-seeded on every showMap() so a session's own live landings are
  // never double-counted against the persisted set.
  if (!mapController) {
    mapController = createUploadMap(r.mapCanvas, null, addMapShard)
    mapController.seedPins(getMapShards())
  }
  return mapController
}

// showMap(persist)/hideMap(persist): the shared toggle logic behind
// both the manual btnShowMap/btnHideMap click and the automatic first-
// upload reveal / boot-time preference restore. `persist` (default
// true) writes the new state to localStorage via setMapShownPref() --
// callers that are only REPLAYING an already-persisted preference
// (enterFiles()'s boot-time restore, above) pass persist=false so
// restoring a preference on load can never itself count as a fresh
// user choice or double-write the same value.
//
// SHOW/HIDE LINK ALWAYS VISIBLE (2026-09-16, "tessera-web-handoff
// adjustments", REVISES the prior "tessera-web-map-follow" law):
// "Show/hide link is always shown." Previously btnShowMap stayed
// hidden until the map had been shown at least once this session
// ("one pair of controls, no third layout" -- the old worry was a
// user seeing "Show map" before there was anything to show). This
// packet explicitly asks for the link to be visible from first paint
// regardless of upload history, so hideMap() below no longer gates
// btnShowMap's visibility on `mapController` truthiness -- the two
// buttons still share the exact same corner slot and still never
// both show at once, only the "only after a map has existed" gate on
// btnShowMap itself is removed.
function showMap(persist = true) {
  ensureMapController()
  r.filesScreen.classList.add('files-narrow')
  r.mapPane.classList.remove('hidden')
  // HIDE MAP MOVED (operator, 2026-09-15): both buttons share the same
  // top-right slot on #filesScreen now -- Show swaps to Hide, never
  // both visible at once.
  r.btnShowMap.classList.add('hidden')
  r.btnHideMap.classList.remove('hidden')
  mapShown = true
  if (persist) setMapShownPref(true)
}

function hideMap(persist = true) {
  r.filesScreen.classList.remove('files-narrow')
  r.mapPane.classList.add('hidden')
  r.btnHideMap.classList.add('hidden')
  r.btnShowMap.classList.remove('hidden')
  mapShown = false
  if (persist) setMapShownPref(false)
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

// ── encoding… activity dots (2026-09-16, "tessera-web-encoding-word",
// revised same day per operator instruction to move onto the progress
// row and animate) ──────────────────────────────────────────────────
//
// LAW: "'encoding...' messaging, move it to the same line as the
// progress bar. When first write commences, progress bar replaces
// it." -- the FIRST REAL onShardUploaded/onShardDownloaded tick IS
// that trigger (doUpload's own callback below already distinguishes
// the one-time 'encoding…' tick from every subsequent real tick; no
// new trigger needed, matching the packet's own "if a different
// trigger already exists, use that" instruction). So: 'encoding…' now
// renders INSIDE r.progressLabel (same DOM node/same line the real
// stage text uses), with r.progressWrap unhidden early (not gated on
// a real tick) so the row is visibly present as soon as encoding
// starts. The first real tick calls stopEncodingAnim() then
// immediately overwrites r.progressLabel via the existing
// patchState({progress:...}) path -- a genuine replace, not a layered
// hide/show.
//
// "One period, then two, then three, then 0, then 1 etc etc." -- a
// 4-step repeating cycle (1,2,3,0 dots), not a monotonic count, so it
// visibly loops as long as encoding is the active stage.
let _encodingTimer = null
let _encodingDots = 1
const ENCODING_STEP_MS = 450

function startEncodingAnim() {
  stopEncodingAnim()
  _encodingDots = 1
  const paint = () => {
    r.progressLabel.textContent = 'encoding' + '.'.repeat(_encodingDots)
    _encodingDots = (_encodingDots + 1) % 4  // 1,2,3,0,1,2,3,0... per "one period, then two, then three, then 0, then 1 etc"
  }
  paint()
  _encodingTimer = setInterval(paint, ENCODING_STEP_MS)
}

function stopEncodingAnim() {
  if (_encodingTimer) { clearInterval(_encodingTimer); _encodingTimer = null }
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

async function doUpload(file, destPathOverride) {
  const sdk = getState().sdk; if (!sdk) return
  setBusy(true)
  // RESEED (2026-09-16, "tessera-web-add-hang-map400"): reset() wipes
  // ALL pins (live AND previously-seeded) so a fresh upload's own
  // trips/pins start from a clean slate -- but "current data
  // locations" must keep showing through a live Add, not just at
  // first map-open. Re-paint the persisted set immediately after
  // every reset, same zero-network seedPins() call ensureMapController
  // used at creation.
  if (mapController) { mapController.reset(); mapController.seedPins(getMapShards()) }
  // FIRST-UPLOAD-ONLY REVEAL (2026-09-16, "tessera-web-handoff
  // adjustments"): "Upon a user's first upload only, map should be
  // unhidden. From then on, user's map preference persists." Every
  // upload used to force showMap() unconditionally; now that only
  // happens when getMapShownPref() is still null (no explicit
  // preference has EVER been recorded -- true first-visit, pre-first-
  // upload state). Once any preference exists -- including the one
  // this very call is about to set -- a later upload must never
  // re-open a map the user explicitly hid. showMap() here persists
  // (default persist=true), which is exactly right: this first reveal
  // IS the moment the preference is born.
  if (getMapShownPref() === null) showMap()
  stopEase()
  // BAR HOLD (2026-09-16, "tessera-web-encode-hold"): "The progress
  // bar does not exist yet. No bar during drop, Ready wait, or
  // encoding." REMOVED: the old `renderProgressBar(0)` +
  // `patchState({ progress: { stage: 'Preparing...', ... } })` pair
  // that used to run here. That patchState call is EXACTLY what made
  // `subscribe('progress', ...)` below unhide r.progressWrap on every
  // single Add before a single byte moved (that subscriber unhides on
  // ANY truthy progress value, stage text irrelevant) -- the "bar
  // jumps straight to uploading" / "bar visible during drop" bug this
  // packet reports. No progress state is set at all now until
  // uploadFile()'s own onProgress callback below fires for the first
  // time, which (per files.js's own comment on its `tick` calls) does
  // not happen until the SDK's onShardUploaded reports a real landed
  // shard -- so the bar and its label stay fully absent through drop,
  // the 10s Ready wait, and the (skipped, no real signal exists)
  // encoding phase. "No 'Preparing...'. No bar at 0% before ship." --
  // status is left exactly as it already was (usually '') rather than
  // set to a placeholder string.
  patchState({ status: '' })
  try {
    // FIX (2026-09-15, "tessera-web-folder-create-fail"): "Add must not
    // hang with no error. If it cannot start the write, fail visible in
    // a few seconds with one sentence. No 5-minute bar. No silent
    // freeze." waitForReady(sdk)'s DEFAULT timeout is 300000ms (5
    // minutes), polling sdk.account() every 5s with ZERO UI update in
    // between -- this is the exact "occupy 0" hang the operator saw:
    // sdk.upload() (and therefore any hosts() contact at all) is never
    // even reached while this call is still pending, so no amount of
    // waiting here ever touches a host. Confirmed by direct read: the
    // progress bar's own patchState() call above already ran with
    // stage: 'Preparing...' BEFORE this line, and nothing between here
    // and uploadFile() below updates it again until this resolves --
    // a customer watching the bar sees it frozen at 0% for up to 5
    // minutes with no distinguishable difference from a true hang.
    // A 10s cap turns that into a fast, visible failure instead --
    // Ready is a near-instant sdk.account() call once truly connected
    // (confirmed by files.js's own getAccount() being a direct,
    // un-retried sdk.account() passthrough); an account still not
    // Ready after 10s of polling is a real, reportable condition, not
    // something worth silently waiting multiple minutes for on every
    // single Add. enterFiles()'s own separate waitForReady() call
    // (line ~714, background/non-blocking, only feeds the header dot)
    // keeps its original 5-minute default -- that one was never the
    // hang, since it never gates Add.
    await waitForReady(sdk, 10000)
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
    //
    // COLLISION (Apple A, 2026-09-16): "Never overwrite. Never two
    // visible names that match... Applies to Move and to Add-into-
    // folder and to Add at Root." destPathOverride (set only by
    // enqueueUploadIntoFolder's folder-row drop) takes priority over
    // getState().currentPath so a drop onto a DIFFERENT folder than
    // the one currently open still targets the folder it was actually
    // dropped on; a plain Add (dropzone/file input, no override) keeps
    // using currentPath exactly as before.
    const { currentPath, files } = getState()
    const destPath = destPathOverride !== undefined ? destPathOverride : currentPath
    const siblingNames = existingBasenamesInFolder(files, destPath)
    const finalBasename = resolveCollisionName(siblingNames, file.name)
    const metaName = destPath ? buildPath(destPath, finalBasename) : (finalBasename !== file.name ? finalBasename : undefined)
    await uploadFile(sdk, file, ({ stage, percent, elapsed, hostKey, transferMs }) => {
      // ENCODING WORD (2026-09-16, "tessera-web-encoding-word", MOVED
      // + ANIMATED same day per operator instruction): "'encoding...'
      // messaging, move it to the same line as the progress bar. When
      // first write commences, progress bar replaces it." files.js
      // still emits exactly one 'encoding…' tick, right before calling
      // sdk.upload() -- that tick IS the existing trigger this packet
      // asks to reuse ("if a different trigger already exists, use
      // that"), so no new signal was added. What changed: this used to
      // route to `status` (a separate DOM node/line below the bar,
      // r.statusText) -- now it unhides r.progressWrap early and
      // starts the animated-dots paint loop directly into
      // r.progressLabel, the SAME node/line every real progress tick
      // already writes to below. The first real tick (the `else`
      // branch) stops the animation and immediately overwrites that
      // same textContent via the normal patchState({progress:...})
      // path -- a genuine replace on the same line, not a hide/show of
      // two different rows.
      if (stage === 'encoding\u2026') {
        r.progressWrap.classList.remove('hidden')
        startEncodingAnim()
        return
      }
      // First real tick past the branch above IS the first shard
      // shipping -- stop the encoding animation now that a real
      // progress tick is about to overwrite the same label text.
      stopEncodingAnim()
      if (getState().status) patchState({ status: '' })
      // Real target only -- setProgressTarget's own ease-out never passes
      // this value (see EASE_MS comment above). The 'done' tick still
      // sets exactly 100, but only files.js ever calls that, after
      // pinObject() has already returned -- never this eased path.
      setProgressTarget(percent)
      patchState({ progress: { stage, percent, elapsed, hostKey, transferMs } })
    }, metaName)
    stopEase()
    // Safety net (2026-09-16): if uploadFile resolved without ever
    // firing a real progress tick (e.g. a 0-shard/trivial object), the
    // encoding animation would otherwise keep running forever with
    // nothing left to overwrite it -- stop it explicitly here too.
    stopEncodingAnim()
    renderProgressBar(100)
    // SUCCESS LINE (2026-09-16, per operator instruction): "there
    // should be a 'success!' message in the event of a successful
    // file write" -- painted into r.progressLabel, the SAME row the
    // progress bar/encoding text just occupied (not a new line, not
    // r.statusText below the file list). progressWrap is kept
    // unhidden (NOT set back to `progress: null` yet) so this success
    // text is actually visible for a moment before the next Add
    // starts and reset()s it via the normal 'encoding…' branch above.
    r.progressLabel.textContent = '\u2705 Success!'
    if (mapController) mapController.completeWrite()
    showToast('\u2705 ' + file.name + ' added')
    // BUG FIX (2026-09-16, per operator report: "after pinning, a
    // message below the file list reads 'Could not add this file. Try
    // again.'" even on writes that actually succeeded): refreshFiles()
    // used to sit INSIDE this try block, so if the post-upload file
    // LISTING call threw for any reason (relay flake, WASM fallback
    // hiccup) -- a completely separate operation from the upload that
    // had already succeeded -- the outer catch below would report the
    // whole Add as failed, overwriting the success text with the fail
    // sentence. Moved outside try/catch (own local try/catch, log-only
    // on failure) so a listing-refresh error can never masquerade as
    // an upload failure.
    try {
      await refreshFiles()
    } catch (e) {
      console.warn('[tessera-web] post-upload file list refresh failed:', e.message)
    }
  } catch (e) {
    // "On fail, freeze and show the fail line." -- stop any in-flight
    // ease immediately so the bar does not keep creeping toward a shard
    // count that will never arrive; the exact frozen percent stays
    // visible under the fail text until the next upload starts.
    stopEase()
    // A throw before any real shard ever shipped (e.g. sdk.upload()
    // itself throws, or waitForReady's 10s cap trips) means the
    // encoding animation could still be running -- stop it so it
    // doesn't keep animating underneath/behind the fail text.
    stopEncodingAnim()
    // COPY (2026-09-15, "tessera-web-look-v1"): "Add failed: one
    // sentence + try again. No stack trace." Was 'Add failed: ' +
    // e.message, which could surface a raw SDK/network error string
    // (a de-facto stack trace to a non-technical reader). One quiet,
    // fixed sentence now -- the real e is still logged to console
    // below for debugging, just never shown in the UI.
    //
    // MOVED (2026-09-16, per operator instruction): this fail line now
    // renders in r.progressLabel -- the SAME progress-bar row the
    // encoding/success text uses -- instead of r.statusText (a
    // separate paragraph below the file list, where this used to
    // surface and read as visually disconnected from the Add that
    // actually failed). progressWrap is kept unhidden (not reset to
    // `progress: null`) so the fail text is actually visible, same
    // pattern as the success line above.
    renderProgressBar(0)
    r.progressLabel.textContent = 'Could not add this file. Try again.'
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
  if (mapController) { mapController.reset(); mapController.seedPins(getMapShards()) }
  // PREFERENCE RESPECTED (2026-09-16, "tessera-web-handoff
  // adjustments"): "If a user has chosen to hide map, then subsequent
  // activity should not change show/hide status." Mirrors doUpload's
  // own fix -- a Download used to force showMap() unconditionally too,
  // which would silently re-open a map the user had explicitly hidden.
  // Only auto-reveal here on the same true-first-visit condition
  // doUpload uses (no preference ever set); once ANY preference
  // exists, Download respects it exactly like every other action.
  if (getMapShownPref() === null) showMap()
  try {
    await downloadToDisk(sdk, sf.id, sf.name, ({ hostKey, direction, transferMs }) => {
      if (mapController && hostKey) mapController.landedHost(hostKey, direction, transferMs)
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

// OLD BEHAVIOR (2026-09-15, "tessera-web-folder-create-fail" era,
// REPLACED by Apple B 2026-09-16, see the function's own comment
// below): "Delete on an empty folder deletes its marker only. Delete
// on a folder that has files: refuse with one sentence ('This folder
// has files.'). Do not mass-delete. Do not recurse." That refuse
// string and the isNonEmptyFolder() guard it relied on are GONE from
// the function itself -- kept only as historical context here so a
// future reader can see what changed and why; isNonEmptyFolder() is
// still exported from files.js (used nowhere in THIS packet) in case
// a future packet wants a read-only "would this delete be large"
// check without actually deleting.
// onDeleteFolder(path, name): (Apple B, 2026-09-16) "Apple: a folder
// is a place. Deleting it deletes what is inside, after a confirm
// that names the damage." REPLACES the old "refuse if non-empty"
// behavior entirely -- the old "This folder has files." string is
// gone, not branched around; a non-empty folder is now a normal,
// supported delete target.
//
// Confirm, exact idea: 'Delete "Photos" and N files?' -- N is
// countFilesUnderFolder(), the SAME query filesUnderFolder() below
// uses for the actual delete loop, so the number shown and the number
// of objects touched can never drift apart. A virtual-only empty
// folder (N===0) still confirms, with the packet's own N=0 wording:
// 'Delete "Photos"?' (no "and 0 files").
async function onDeleteFolder(path, name) {
  const { files } = getState()
  const targets = filesUnderFolder(files, path)
  const n = targets.length
  const question = n > 0
    ? 'Delete "' + name + '" and ' + n + (n === 1 ? ' file' : ' files') + '?\n\nThis cannot be undone.'
    : 'Delete "' + name + '"?\n\nThis cannot be undone.'
  if (!confirm(question)) return  // Cancel leaves everything -- no state touched above this line
  const sdk = getState().sdk
  if (n > 0 && !sdk) return  // real objects to delete but no sdk -- nothing safe to do
  setBusy(true); patchState({ status: 'Deleting\u2026' })
  try {
    // "deleteObject each of those files" -- law explicitly allows
    // this (it is a per-file deleteObject call, not a host-list
    // fetch). deleteFile() is the existing single-object delete path
    // (Web falls through relay-miss to sdk.deleteObject, same as
    // every other op in this file) -- reused verbatim per file here,
    // not a new deletion mechanism.
    for (const f of targets) {
      await deleteFile(sdk, f.id)
    }
    // "if a leftover marker object exists from the abandoned pin era,
    // delete that too" -- a LEGACY marker's own metadata.name is
    // EXACTLY path + '/' (folderMarkerName()), which filesUnderFolder()
    // above does NOT match (it only matches path itself or path+'/...'
    // with content after the slash) and explicitly excludes anyway via
    // its own mime !== FOLDER_MARKER_MIME guard -- so it is never
    // double-counted in N and never double-deleted by the loop above.
    // findFolderMarkerId() still needs a real object list to search,
    // so this must run BEFORE getVirtualFolders()/removeVirtualFolderPrefix
    // change nothing here (markers are real objects, not virtual rows).
    const markerId = findFolderMarkerId(files, path)
    if (markerId) await deleteFile(sdk, markerId)
    // "drop the virtual path and child virtual paths" -- clears this
    // folder's own virtual row (if it was empty-only) AND any virtual
    // subfolder that lived under it, so nothing orphans in
    // tesseraweb.folders with an unreachable parent.
    removeVirtualFolderPrefix(path)
    // "Stay in the parent folder after." -- if the browser is
    // currently inside the folder being deleted (or a descendant of
    // it), back out to its parent; otherwise the current view is
    // untouched (deleting a folder from a different, still-valid
    // location must not navigate the browser away from where it was).
    const curPath = getState().currentPath
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const landingPath = (curPath === path || curPath.startsWith(path + '/')) ? parentPath : curPath
    await refreshFiles()
    patchState({ status: '', currentPath: landingPath })
    renderBreadcrumb()
    showToast('\u{1F5D1}\uFE0F Deleted: ' + name)
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
  // ⚠️ UNUSED AS OF 2026-09-16 ("tessera-web-handoff adjustments"):
  // the "Remove from this browser" button + its horizontal separator
  // line were removed from the #filesScreen skeleton (and this
  // function's own event listener wire-up removed) per explicit
  // operator instruction: "Remove both. The space freed up is now
  // part of the files-list area." This function's LOGIC was
  // deliberately kept, unused, at the operator's own request ("Leave
  // it in the code. Note it prominently.") in case the capability
  // needs to be re-exposed elsewhere later -- it is not dead code by
  // accident, do not delete it as part of an unrelated cleanup pass
  // without checking with the operator first. clearCredentials(PREFIX)
  // is still a real, correct call (deletes tesseraweb.* -- see the
  // "lock / remove from this browser" law above); only the UI entry
  // point to reach this function is gone.
  if (!confirm('Remove Tessera from this browser? You will need your 12 words to come back.')) return
  clearCredentials(PREFIX)
  patchState({
    sdk: null, accountReady: false,
    files: [], selectedIdx: -1, totals: { count: 0, totalBytes: 0 },
    builder: null, phrase: '', status: '', progress: null,
  })
  doBoot()
}
