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
  isTailZone,
  buildPath, folderMarkerName, validateFolderName, computeFolderView,
  isNonEmptyFolder, findFolderMarkerId,
  getVirtualFolders, addVirtualFolder,
  computeAllFolderPaths, existingBasenamesInFolder, resolveCollisionName,
  validateRenameName, renameObjectPath,
  getMapShards, addMapShard,
  getMapShownPref, setMapShownPref,
  filesUnderFolder, countFilesUnderFolder, renameFilePath,
  validateFolderRenameName, renameVirtualFolderPrefix, removeVirtualFolderPrefix,
  isRealUploadInFlight, waitForUploadSlot,
  isDebugOn, diaryPush, hex8,
} from './files.js'
import { createUploadMap } from './map.js'
import {
  getState, patchState, subscribe, selectedFile,
  showToast, setBusy, setScreen,
} from './store.js'
import { formatBytes, esc, fmtDateTime, $ } from './utils.js'
import { hasWrappedVault, unwrapAppKey } from './vault.js'

const PREFIX = 'tesseraweb'

// DESKTOP PARITY (2026-09-29): Tessera Web ('idx' fetch mode) assumes a
// same-origin nginx /v2/tessera/web/idx/ location -- that doesn't exist in
// the Electron desktop app (no nginx there at all). The desktop app's own
// bundled local proxy (apps/desktop/electron/main.js -> packages/proxy)
// already implements '/__proxy__' (Drop/ui.js's exact existing route,
// already fixed and verified working there) -- reuse THAT instead of
// inventing a second '/idx/' route. Everywhere this file passed the
// literal string 'idx' to initSia/reconnectWithAppKey/beginRecovery/
// connectWithInvite, use FETCH_MODE() instead: 'idx' in the browser,
// undefined (-> installFetchInterceptor's default 'proxy' mode) in
// desktop, matching Drop's own desktop behavior exactly.
function FETCH_MODE() {
  return (window.tesseraDesktop && window.tesseraDesktop.isDesktop) ? undefined : 'idx'
}

function isDesktop() {
  return !!(window.tesseraDesktop && window.tesseraDesktop.isDesktop)
}

/**
 * In the Electron desktop app, also connect the native NAPI SDK in the
 * main process so upload/download work via raw TCP (same mechanism as
 * Drop/ui.js's initNativeBridge() -- ported verbatim, PREFIX-aware).
 *
 * `appKeyHex` is optional -- pass it explicitly when the key just came
 * from somewhere other than plaintext localStorage (e.g. Unlock's
 * unwrapAppKey() result), since getSaved(PREFIX).appKey is empty once a
 * password/vault is set. Falls back to getSaved(PREFIX) otherwise.
 */
async function initNativeBridge(appKeyHex) {
  if (!isDesktop()) return
  const saved = getSaved(PREFIX)
  const appId = saved.appId
  const appKey = appKeyHex || saved.appKey
  if (!appKey || !appId) return
  try {
    const result = await window.tesseraDesktop.siaConnect(appId, appKey)
    if (!result.ok) console.warn('Native bridge connect failed:', result.error)
  } catch (e) {
    console.warn('Native bridge unavailable:', e.message)
  }
}

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
    'fileMenu', 'fileMenuDownload', 'fileMenuShare', 'fileMenuMove', 'fileMenuRename', 'fileMenuDelete',
    'btnNewFolder', 'breadcrumb', 'newFolderInline', 'newFolderInput',
    'btnNewFolderConfirm', 'btnNewFolderCancel',
    'btnSelectMany', 'selectManyBar', 'selectManyCount', 'btnSelectAll',
    'btnSelectManyMove', 'btnSelectManyDelete', 'btnSelectManyDone',
    'filesLayout', 'btnShowMap', 'mapPane', 'btnHideMap', 'mapCanvas',
    'mapColumn', 'debugPane', 'debugLog', 'btnDebugCopy',
    'statusText', 'progressWrap', 'progressFill', 'progressLabel',
    'shareModal', 'shareLink', 'btnCopyLink', 'btnCloseModal',
    'textInputModal', 'textInputTitle', 'textInputField', 'textInputError',
    'btnTextInputConfirm', 'btnTextInputCancel',
    'moveModal', 'moveModalList', 'btnMoveCancel',
    'btnSyncFolders', 'syncFoldersModal', 'syncWatcherStatus', 'syncFolderList',
    'syncFoldersError', 'btnAddSyncFolder', 'btnCloseSyncFolders',
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
    <!-- SYNCED FOLDERS (2026-09-29): desktop-only entry point for the
         tessera-cli-backed folder sync/watcher feature -- shown only when
         isDesktop() (see wireEvents() below), never in the browser build,
         since there is no local filesystem or bundled CLI to drive there. -->
    <button id="btnSyncFolders" class="btn btn-ghost hidden">Synced Folders</button>
    <button id="btnLock" class="btn btn-ghost btn-logout">Lock</button>
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
          <div class="dz-hint">or click to browse, or drop a folder</div>
        </div>
        <button id="btnNewFolder" class="btn btn-outline btn-new-folder">New folder</button>
        <!-- SELECT MANY (Apple C, 2026-09-17): "A Select control on the
             Files list (Apple: Select, tap items, action at the
             bottom)." Toggles selectMode -- renderFileList() below then
             switches every visible row into checkbox mode. Sits next to
             New folder, same toolbar row, no new layout invented. -->
        <button id="btnSelectMany" class="btn btn-outline btn-select-many">Select</button>
      </div>
      <!-- SELECT-MANY TOOLBAR (Apple C, 2026-09-17): only visible while
           selectMode is on. "Select all in this place is allowed."
           Done exits select mode (does not clear the underlying single-
           item selectedIdx model -- the two selection systems are
           independent, see store.js's own comment). -->
      <div id="selectManyBar" class="select-many-bar hidden">
        <span id="selectManyCount" class="select-many-count"></span>
        <button id="btnSelectAll" class="btn btn-ghost">Select all</button>
        <button id="btnSelectManyMove" class="btn" disabled>Move</button>
        <button id="btnSelectManyDelete" class="btn btn-danger" disabled>Delete</button>
        <button id="btnSelectManyDone" class="btn btn-ghost">Done</button>
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
      <!-- FILE ACTIONS MENU (2026-09-19, "tessera-web-file-menu"): the
           actions-bar row above overflowed the panel on both sides at
           normal widths (six always-visible full-size buttons in one
           unwrapped flex row, no overflow handling -- see
           .actions-bar in style.css). REPLACED for single-row selection
           with this small vertical popup, anchored to the right of
           whichever row triggered it (positionFileMenu() below does the
           anchoring/clamping). Kept hidden in the DOM by default;
           #fileActions above is left in place UNUSED (still queried by
           id, still toggled, but no longer the thing the operator sees
           for a single selected row -- see subscribe('selectedIdx', ...)
           below) rather than deleted, since selectedFile()-driven
           enable/disable logic elsewhere still reads its buttons' own
           .disabled state as a single source of truth for whether an
           action is currently valid; this menu's own items call the
           EXACT SAME handlers (onDownload/onShare/onMove/onRename/
           onDelete) rather than duplicating any logic. -->
      <div id="fileMenu" class="file-menu hidden" role="menu">
        <button id="fileMenuDownload" class="file-menu-item" role="menuitem">Download</button>
        <button id="fileMenuShare" class="file-menu-item" role="menuitem">Share</button>
        <button id="fileMenuMove" class="file-menu-item" role="menuitem">Move</button>
        <button id="fileMenuRename" class="file-menu-item" role="menuitem">Rename</button>
        <button id="fileMenuDelete" class="file-menu-item file-menu-item-danger" role="menuitem">Delete</button>
      </div>
      <p id="statusText" class="status-text"></p>
    </section>

    <!-- MAP COLUMN (2026-09-24, "tessera-web-debug-log"): a pure layout
         wrapper -- #filesLayout is a flex ROW (filesScreen | this column),
         so stacking the debug panel "under the map" in the SAME column
         needs one flex-column wrapper around both asides. #mapPane keeps
         every one of its own existing rules/classes/animation untouched
         (this wrapper adds no width/margin of its own that would fight
         .map-pane's width 0<->800px slide -- see that rule's own
         comment); it simply gives .debug-pane somewhere to stack below
         it without becoming a THIRD flex item next to the map. -->
    <div id="mapColumn" class="map-column">
    <aside id="mapPane" class="map-pane hidden">
      <canvas id="mapCanvas" class="map-canvas"></canvas>
      <!-- CAPTION KILLED (2026-09-15, "tessera-web-map-follow"):
           "Kill the map caption... No replacement sentence this
           packet. Progress stays on the files pane as N/30." The
           #mapCaption element itself is removed, not just left empty
           -- there is no lower-left text node on the map pane at all
           anymore. -->
    </aside>

    <!-- DEBUG PANE (2026-09-24, "tessera-web-debug-log"): "a panel
         under the map (same column as the old caption gutter)...
         if the map is closed, the panel still exists under that slot
         so Copy is reachable." Deliberately its OWN sibling aside,
         never a child of #mapPane -- #mapPane's own .hidden class
         (toggled purely by showMap()/hideMap(), untouched by this
         packet) must never also hide this panel when the operator
         has the map closed but debug=1 on the URL. Visibility here is
         driven SOLELY by the debug-flag reader (syncDebugPane() below)
         -- never by mapShown. Starts hidden (no query = no panel, no
         Copy, no extra DOM, per law). -->
    <aside id="debugPane" class="debug-pane hidden">
      <div class="debug-pane-header">
        <h3>Debug</h3>
        <button id="btnDebugCopy" class="btn btn-ghost btn-debug-copy">Copy</button>
      </div>
      <div id="debugLog" class="debug-log"></div>
    </aside>
    </div>
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

  <!-- SYNCED FOLDERS MODAL (2026-09-29): desktop-only, same modal-card
       look as the other modals -- no new component family. Drives the
       bundled tessera-cli binary over IPC (see cli-bridge.mjs); "watcher"
       is the CLI's own OS-native background service, installed
       automatically the moment the first folder is added (see
       onAddSyncFolder below), not a separate step the user has to take. -->
  <div id="syncFoldersModal" class="modal-overlay hidden">
    <div class="modal-card">
      <h3>Synced Folders</h3>
      <p class="hint">A synced folder stays up to date automatically, like a
        cloud drive folder — even while Tessera isn&rsquo;t open.</p>
      <p id="syncWatcherStatus" class="status-text"></p>
      <div id="syncFolderList" class="file-list sync-folder-list"></div>
      <p id="syncFoldersError" class="status-text"></p>
      <div class="modal-buttons">
        <button id="btnAddSyncFolder" class="btn btn-primary">Add a folder&hellip;</button>
        <button id="btnCloseSyncFolders" class="btn btn-ghost">Close</button>
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
  // SELECT MANY (Apple C, 2026-09-17): wired the same way New folder's
  // own inline toggle is -- a plain click handler flipping selectMode,
  // no new modal/component family.
  r.btnSelectMany.addEventListener('click', onEnterSelectMode)
  r.btnSelectManyDone.addEventListener('click', onExitSelectMode)
  r.btnSelectAll.addEventListener('click', onSelectAllInPlace)
  r.btnSelectManyMove.addEventListener('click', onSelectManyMove)
  r.btnSelectManyDelete.addEventListener('click', onSelectManyDelete)
  r.btnMoveCancel.addEventListener('click', closeMoveModal)
  r.btnRename.addEventListener('click', onRename)
  // FILE MENU (2026-09-19, "tessera-web-file-menu"): each menu item
  // calls the EXACT SAME handler its old #fileActions button called --
  // "same verbs" is enforced simply by wiring to the same functions,
  // not by copying/reimplementing them. Close the menu on every action
  // click regardless of outcome (a failed action still shows its own
  // toast/fail sentence elsewhere; the menu closing is independent of
  // that).
  r.fileMenuDownload.addEventListener('click', () => { closeFileMenu(); onDownload() })
  r.fileMenuShare.addEventListener('click', () => { closeFileMenu(); onShare() })
  r.fileMenuMove.addEventListener('click', () => { closeFileMenu(); onMove() })
  r.fileMenuRename.addEventListener('click', () => { closeFileMenu(); onRename() })
  r.fileMenuDelete.addEventListener('click', () => { closeFileMenu(); onDelete() })
  r.btnTextInputConfirm.addEventListener('click', onTextInputConfirm)
  r.btnTextInputCancel.addEventListener('click', closeTextInputModal)
  r.textInputField.addEventListener('keydown', e => { if (e.key === 'Enter') onTextInputConfirm() })
  r.breadcrumb.addEventListener('click', onBreadcrumbClick)

  // Dropzone: desktop uses the native file dialog. files.js's uploadFile()
  // would happily prompt its own dialog if given file=null (like Drop/
  // ui.js does) -- but Tessera Web's doUpload() reads file.name/file.size
  // directly for its OWN UI (queue toast, collision-name check, success
  // toast) before ever calling uploadFile(), so a bare null crashes there.
  // Resolve the file via IPC here first, build a lightweight stand-in
  // object carrying the real name/size plus the pre-fetched path/buffer,
  // and feed THAT into the exact same enqueueUpload() queue the browser
  // drop path already uses -- one upload pipeline, not two. uploadFile()
  // recognizes __desktopBuffer and skips its own (would-be duplicate)
  // dialog prompt.
  if (isDesktop()) {
    r.dropzone.addEventListener('click', async () => {
      try {
        const filePath = await window.tesseraDesktop.openFileDialog()
        if (!filePath) return  // user cancelled the dialog -- no-op, same as Drop
        const fileBuffer = await window.tesseraDesktop.readFile(filePath)
        const name = filePath.split('/').pop() || filePath.split('\\').pop() || 'upload'
        enqueueUpload({ name, size: fileBuffer.length, __desktopPath: filePath, __desktopBuffer: fileBuffer })
      } catch (e) {
        showToast('Could not read that file: ' + (e.message || 'Unknown error'))
      }
    })
  } else {
    r.dropzone.addEventListener('click', () => r.fileInput.click())
  }

  // Synced Folders (2026-09-29): desktop-only, hidden entirely in the
  // browser build (no local filesystem / bundled CLI there).
  if (isDesktop()) {
    r.btnSyncFolders.classList.remove('hidden')
    r.btnSyncFolders.addEventListener('click', onOpenSyncFolders)
    r.btnAddSyncFolder.addEventListener('click', onAddSyncFolder)
    r.btnCloseSyncFolders.addEventListener('click', () => r.syncFoldersModal.classList.add('hidden'))
  }
  r.fileInput.addEventListener('change', onFilePicked)
  r.btnDownload.addEventListener('click', onDownload)
  r.btnDelete.addEventListener('click', onDelete)
  r.btnShare.addEventListener('click', onShare)
  r.btnCloseModal.addEventListener('click', closeShareModal)
  r.btnCopyLink.addEventListener('click', onCopyLink)
  // DEBUG PANE (2026-09-24, "tessera-web-debug-log"): Copy button --
  // "One click. Clipboard write of the full diary text." wired here
  // alongside every other Files-screen button listener; the pane's own
  // visibility is handled separately by syncDebugPane() (boot/popstate/
  // enterFiles), never gated on this listener existing.
  r.btnDebugCopy.addEventListener('click', onDebugCopy)

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
    // FILE MENU (2026-09-19, "tessera-web-file-menu"): "Click outside,
    // Escape, or picking an action closes the menu." Picking an action
    // is already handled at each menu item's own listener above (they
    // call closeFileMenu() directly, unconditionally, before running
    // their action). This covers the other two triggers for the popup
    // specifically -- a click that lands on the row that OPENED the
    // menu is deliberately allowed through to fall to the row's own
    // click handler above (which toggles the menu itself), so this
    // only needs to guard clicks that land ON the open menu's own
    // content (its own items already close it themselves, but a click
    // on the menu's padding/gap, not an item, must not fall through to
    // the outside-closes-menu branch below and immediately re-close
    // something already mid-click).
    if (e.target.closest('#fileMenu')) return
    if (!e.target.closest('.file-row')) closeFileMenu()
    if (getState().selectedIdx === -1) return
    if (e.target.closest('.file-row')) return
    if (e.target.closest('#fileActions')) return
    if (e.target.closest('.modal-overlay')) return
    patchState({ selectedIdx: -1 })
  })
  // FILE MENU (2026-09-19, "tessera-web-file-menu"): Escape closes the
  // menu -- "mouse + Escape is enough" per the packet's own fallback
  // clause; arrow-key/Enter item navigation was judged the "tangle" it
  // pre-emptively allows skipping, so this is the only keyboard wiring
  // added. Does not also clear selectedIdx -- Escape's job here is
  // just closing the popup, not deselecting the row underneath it.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !r.fileMenu.classList.contains('hidden')) closeFileMenu()
  })
  // FILE MENU (2026-09-19, "tessera-web-file-menu"): a resize can
  // invalidate the clamped position (e.g. rotating a device, or the
  // window shrinking) -- reposition against the row that's still
  // selected rather than leaving a stale, possibly now-clipped rect.
  // Closing outright on resize would be equally correct per the
  // packet's own click-outside/Escape/action-only close list, but
  // repositioning keeps the menu usable through a resize instead of
  // silently vanishing on the operator mid-click.
  window.addEventListener('resize', () => {
    if (r.fileMenu.classList.contains('hidden')) return
    const sf = selectedFile()
    if (!sf) { closeFileMenu(); return }
    const rows = r.fileList.querySelectorAll('.file-row')
    const row = Array.from(rows).find(rw => rw.querySelector('.file-name') && rw.querySelector('.file-name').textContent === sf.displayName)
    if (row) positionFileMenu(row); else closeFileMenu()
  })

  r.dropzone.addEventListener('dragover', e => { e.preventDefault(); r.dropzone.classList.add('dragover') })
  r.dropzone.addEventListener('dragleave', () => r.dropzone.classList.remove('dragover'))
  r.dropzone.addEventListener('drop', e => {
    e.preventDefault(); r.dropzone.classList.remove('dragover')
    // OS FOLDER DROP (Apple C, 2026-09-17): "Drop an OS folder onto Add
    // (or onto the list). DataTransferItem.webkitGetAsEntry / directory
    // entries, or webkitdirectory. Not a zip." Checked FIRST, before the
    // plain-Files fallback below -- a directory entry has no `.files`
    // Blob of its own (dataTransfer.files for a dropped folder is either
    // empty or browser-dependent), so enqueueOsEntries() must get first
    // look at dataTransfer.items to recognize a real directory drop at
    // all. Returns false (falls through to the unchanged loose-file
    // path below) when nothing in the drop was a directory -- "Dropping
    // loose files onto Add stays as today."
    if (e.dataTransfer.items && e.dataTransfer.items.length && enqueueOsEntries(e.dataTransfer.items, getState().currentPath)) return
    const f = e.dataTransfer.files; if (f && f.length) enqueueUpload(f[0])
  })

  // OS FOLDER DROP ONTO THE LIST (Apple C, 2026-09-17): "Drop an OS
  // folder onto Add (OR ONTO THE LIST)." r.fileList itself is a second
  // valid drop target for the SAME directory-drop path -- reuses
  // enqueueOsEntries()/getState().currentPath exactly like the dropzone
  // above; a plain loose-file drop onto the list (never supported
  // before this packet either) is intentionally NOT wired here, only
  // directory drops -- the packet's own scope is "an OS folder," not a
  // general second dropzone for single files.
  r.fileList.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() })
  r.fileList.addEventListener('drop', e => {
    if (!e.dataTransfer.items || !e.dataTransfer.items.length) return
    // A drop that landed on a folder row itself already has its OWN
    // drop handler (renderFileList()'s per-row listener) which calls
    // stopPropagation... it does not -- guard here defensively by
    // checking the target is the list surface, not a row, so a folder
    // row drop is never double-handled by both this listener and the
    // row's own.
    if (e.target.closest('.file-row')) return
    e.preventDefault()
    enqueueOsEntries(e.dataTransfer.items, getState().currentPath)
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
    // DEBUG PANE (2026-09-24, "tessera-web-debug-log"): "Read the flag
    // at boot and on popstate / in-app navigation so Back keeps the
    // switch." Browser Back/Forward is a real navigation the URL query
    // can change across, so re-read it here every time, not just once
    // at boot.
    syncDebugPane()
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
    // FILE MENU (2026-09-19, "tessera-web-file-menu"): mirrors the same
    // busy-gate onto the popup's own items -- a busy upload/download
    // must disable Move/Rename/Delete/Download/Share here exactly like
    // it always disabled the old bar's buttons, since these items call
    // the identical handlers.
    r.fileMenuDownload.disabled = v || !sf
    r.fileMenuShare.disabled = v || !sf
    r.fileMenuMove.disabled = v || !sf
    r.fileMenuRename.disabled = v || !sf
    r.fileMenuDelete.disabled = v || !sf
  })
  subscribe('files', () => { renderFileList(); updateTotals() })
  subscribe('currentPath', () => {
    // SELECT MANY (Apple C, 2026-09-17): navigating to a different place
    // (breadcrumb tap, folder enter, Back) clears any in-progress
    // selection -- a checked file from "Photos" has no meaning once the
    // view has moved to "Files" or "Travel". Exiting select mode itself
    // is NOT forced here (only the checked SET is cleared) so tapping
    // into a folder while still in Select mode keeps the toolbar up,
    // ready to check items in the new place -- matching "current place"
    // scoping from the packet's own wording without inventing a second
    // per-folder selection cache.
    if (getState().selectedIds.length) patchState({ selectedIds: [] })
    // FILE MENU (2026-09-19, "tessera-web-file-menu"): a currentPath
    // change (breadcrumb tap, folder enter, Back) invalidates whatever
    // row the menu was anchored to -- close it the same way the
    // checked SET above is cleared, rather than leaving it floating
    // over a place that no longer has that row.
    closeFileMenu()
    renderFileList(); renderBreadcrumb()
  })
  subscribe('selectedIdx', () => {
    renderFileList()
    const sf = selectedFile()
    r.btnDownload.disabled = !sf || getState().busy
    r.btnShare.disabled = !sf || getState().busy
    r.btnMove.disabled = !sf || getState().busy
    r.btnRename.disabled = !sf || getState().busy
    r.btnDelete.disabled = !sf || getState().busy
    r.fileActions.classList.toggle('hidden', !sf)
    r.fileMenuDownload.disabled = !sf || getState().busy
    r.fileMenuShare.disabled = !sf || getState().busy
    r.fileMenuMove.disabled = !sf || getState().busy
    r.fileMenuRename.disabled = !sf || getState().busy
    r.fileMenuDelete.disabled = !sf || getState().busy
    // FILE MENU (2026-09-19, "tessera-web-file-menu"): a row
    // deselecting (click-outside, Cancel, navigation) with no new row
    // taking its place must also close the popup -- the row it was
    // anchored to may no longer even be selected/highlighted.
    if (!sf) closeFileMenu()
  })
  // SELECT MANY (Apple C, 2026-09-17): a SEPARATE toolbar/state from the
  // single-item fileActions bar above -- both can exist in the DOM at
  // once (selectMode simply hides fileActions' row-click-to-select
  // behavior in favor of checkboxes; see renderFileList()'s own branch).
  subscribe('selectMode', v => {
    r.selectManyBar.classList.toggle('hidden', !v)
    r.btnSelectMany.textContent = v ? 'Cancel' : 'Select'
    // FILE MENU (2026-09-19, "tessera-web-file-menu"): entering Select
    // mode switches every row to checkbox-toggle click behavior (see
    // renderFileList()'s own selectMode branch) -- the single-row popup
    // menu has no meaning there (its actions are single-item; the
    // select-many bottom bar covers the multi-item case per this
    // packet's own law), so close it on the transition either way.
    closeFileMenu()
    renderFileList()
  })

  subscribe('selectedIds', v => {
    r.selectManyCount.textContent = v.length ? v.length + ' selected' : ''
    // Rename stays one item (packet's own law) -- Move/Delete are the
    // only two actions this toolbar exposes, both no-ops on an empty
    // selection per "Empty selection: Move/Delete do nothing."
    r.btnSelectManyMove.disabled = v.length === 0 || getState().busy
    r.btnSelectManyDelete.disabled = v.length === 0 || getState().busy
    // BUG FIX (2026-09-17, operator report: "the selected number never
    // rises above 1"): renderFileList() builds each row's
    // toggleChecked() closure over the `selectedIds` value from THAT
    // render call -- this subscriber used to only update the count/
    // button text above and never re-rendered the list, so every row's
    // click handler kept closing over the STALE (often still-empty)
    // array from the render before the user's first click. Each
    // subsequent click computed `next = [...staleEmptyArray, thisEntry]`
    // -- always length 1, no matter how many boxes were already
    // checked. Re-rendering here rebuilds every row's closure against
    // the CURRENT selectedIds so the next click always starts from the
    // real running total, not a snapshot from mount time.
    renderFileList()
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
  initSia(FETCH_MODE()).catch(e => console.warn('[tessera-web] preload initSia failed:', e.message))
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
    // route has no CORS headers on index.tessera.storage directly, so 'direct'
    // mode's cross-origin call was failing preflight ("Failed to fetch").
    // If this ever stops working (proxy route removed, Indexd hardened),
    // it throws and the catch below shows the real error -- this path does
    // not fall back to a second tab.
    const { builder, appId, phrase } = await connectWithInvite(invite, PREFIX, FETCH_MODE())
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
    const result = await beginRecovery(phrase, msg => { r.recoverStatus.textContent = msg }, PREFIX, FETCH_MODE())

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
  if (!pw) { r.unlockStatus.textContent = 'Enter your password.'; return }

  r.btnUnlock.disabled = true
  r.unlockStatus.textContent = 'Unlocking\u2026'

  try {
    const appKeyHex = await unwrapAppKey(pw, PREFIX)
    const { appId } = getSaved(PREFIX)
    // TIMEOUT (2026-09-19, "tessera-web-unlock-hang"): reconnectWithAppKey()
    // has NO internal cap of its own -- it directly `await`s
    // `builder.connected(key)`, a WASM call into the SDK's own
    // connect/account logic, with nothing bounding how long that can take.
    // auth.js's internal try/catch only covers a SYNCHRONOUS throw or a
    // rejected promise; it does nothing if that promise simply never
    // settles. When it hangs, this await never returns, the catch below
    // never fires, and the button stays disabled forever with no status
    // text -- this IS the silent Unlock hang the packet reports. Reuse
    // the same Promise.race timeout technique files.js's own
    // waitForReady(sdk, 10000) already uses elsewhere on this exact
    // account-ready check, so one stuck connect attempt becomes a fast,
    // visible failure instead of an indefinite freeze. Per law: never
    // await map origin / ipwho.is / hosts() on this path -- this timeout
    // wraps ONLY the reconnect/account call already on this path, it
    // does not add any new network call.
    let timer = null
    const sdk = await Promise.race([
      reconnectWithAppKey(appId, appKeyHex, FETCH_MODE()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('reconnect timed out')), 10000) }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
    if (!sdk) {
      // Wrong password or a stale/rejected key -- stay, do NOT delete
      // the vault, per law.
      r.unlockStatus.textContent = 'That password did not work.'
      r.btnUnlock.disabled = false
      return
    }
    patchState({ sdk })
    registerSdk(sdk)
    await initRelay()
    r.unlockPassword.value = ''
    await enterFiles(appKeyHex)
  } catch (e) {
    if (e && e.message === 'reconnect timed out') {
      // Reconnect/account/wasm init never resolved within the 10s cap --
      // stay on Unlock, vault untouched, re-enable the button per law.
      r.unlockStatus.textContent = 'Could not reach your account. Try again.'
      r.btnUnlock.disabled = false
      console.error(e)
      return
    }
    // unwrapAppKey throws on a wrong password too (AES-GCM auth-tag
    // mismatch) -- same "stay on Unlock, vault untouched" outcome.
    r.unlockStatus.textContent = 'That password did not work.'
    r.btnUnlock.disabled = false
    console.error(e)
  }
}

function onForgotPassword() {
  onShowRecover()
}

// ── files ────────────────────────────────────────────────

async function enterFiles(appKeyHex) {
  // DESKTOP PARITY (2026-09-29): connect the native NAPI SDK bridge too
  // (no-op in the browser -- initNativeBridge() returns immediately when
  // !isDesktop()), mirroring Drop/ui.js's initNativeBridge() call sites.
  await initNativeBridge(appKeyHex)
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
  // DEBUG PANE (2026-09-24, "tessera-web-debug-log"): "Read the flag at
  // boot and on popstate / in-app navigation." Entering Files (Unlock,
  // Ready, or first boot -- see this function's own top-of-file comment)
  // is exactly such a navigation.
  syncDebugPane()
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
  refreshFiles().catch(e => {
    console.warn('[tessera-web] initial file list load failed:', e.message)
    // DEBUG DIARY (2026-09-26, "tessera-web-debug-dl"): "list-fail --
    // files list fetch threw (no object names)."
    diaryPush('list-fail err=' + String(e.message || e).slice(0, 80))
  })

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
    // DEBUG DIARY (2026-09-26, "tessera-web-debug-dl"): "reconnect-fail
    // -- existing connected()/reconnect catch. No key material." This
    // is the closest existing connected()-style catch in this file (a
    // waitForReady()+getAccount() health check, not the Unlock/password
    // flow -- that flow is explicitly excluded from the diary by the
    // packet's own law and is left untouched). e.message only.
    diaryPush('reconnect-fail err=' + String(e.message || e).slice(0, 80))
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

// FILE MENU (2026-09-19, "tessera-web-file-menu"; REPOSITIONED
// 2026-09-20, operator report -- "opens top/left of the page,
// instead of right of the selected file/folder"): the ORIGINAL
// clamp bounded the menu's right edge against #filesLayout's own
// right edge (the files pane) -- but a file/folder row already
// spans that pane's FULL WIDTH (see .file-row in style.css, no
// margin/inset from the panel edge), so rowRect.right sits AT or
// PAST the pane's own right boundary on every row, every time. That
// made the "would it clip the pane's right edge" check fire
// unconditionally, flipping the menu to the row's LEFT side on
// essentially every click -- never actually opening to the right,
// exactly the reported bug. FIX: clamp against the VIEWPORT only
// (window.innerWidth/innerHeight), not the narrow files-pane column
// -- the popup is a page-level overlay (position: fixed, z-index
// above everything), it has no reason to stay boxed inside a 420px
// column when the rest of the page (map pane, empty space) is right
// there. Falling back to the row's left side is now a true last
// resort: only when the viewport itself has no room to the right,
// not whenever the narrow file list column runs out.
//
// VERTICAL: "if there is space, center it vertically on the file/
// folder clicked" -- default anchor is now the row's OWN vertical
// center, not its top. "If near the bottom of the page, adjust up
// until it entirely shows" -- shifts up (never down past the
// viewport's own top) exactly enough to fit, same clip-flip
// mechanism as before, just centered instead of top-anchored as the
// starting point.
function positionFileMenu(anchorRow) {
  const menu = r.fileMenu
  const rowRect = anchorRow.getBoundingClientRect()
  // Measure the menu's own natural size first (still hidden -> 0x0),
  // so open it invisibly-but-measurable before the real paint.
  menu.style.visibility = 'hidden'
  menu.classList.remove('hidden')
  const menuRect = menu.getBoundingClientRect()
  menu.style.visibility = ''

  const viewportW = window.innerWidth
  const viewportH = window.innerHeight
  const GAP = 6

  let left = rowRect.right + GAP
  // CLIP FLIP -- horizontal: only flips to the row's LEFT side when
  // the VIEWPORT's own right edge would clip the menu -- the files
  // pane's own (much narrower) edge is no longer a boundary at all,
  // per the fix note above.
  if (left + menuRect.width > viewportW) {
    left = rowRect.left - menuRect.width - GAP
  }
  // Absolute last resort: neither side fits within the viewport
  // itself (an extremely narrow window) -- clamp inside the viewport
  // rather than running off both edges.
  if (left < 0) left = Math.max(0, viewportW - menuRect.width)

  // Default: vertically centered on the row, per "if there is space,
  // center it vertically on the file/folder clicked."
  let top = rowRect.top + (rowRect.height / 2) - (menuRect.height / 2)
  // CLIP FLIP -- vertical: "adjust the relative position of the
  // action column up, until it entirely shows within the visible
  // screen" -- shift up just enough to clear the viewport's bottom
  // edge, then never past the viewport's own top edge either (a row
  // near the very top of the page, if that combination is ever
  // possible, still gets clamped downward to stay fully on-screen).
  if (top + menuRect.height > viewportH) top = viewportH - menuRect.height
  if (top < 0) top = 0

  menu.style.left = Math.round(left) + 'px'
  menu.style.top = Math.round(top) + 'px'
}


let _fileMenuOpenFor = -1
function openFileMenu(anchorRow) {
  positionFileMenu(anchorRow)
  r.fileMenu.classList.remove('hidden')
  _fileMenuOpenFor = getState().selectedIdx
}
function closeFileMenu() {
  r.fileMenu.classList.add('hidden')
  _fileMenuOpenFor = -1
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
  const { files, selectedIdx, currentPath, selectMode, selectedIds } = getState()
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

  // SELECT MANY (Apple C, 2026-09-17): a folder/file entry's checked
  // state is looked up by identity -- folders by path, files by id --
  // against the single flat selectedIds array (see store.js's own
  // shape comment). isChecked()/toggleChecked() are the only two
  // places that array is read/written from inside row rendering, so
  // there is exactly one code path for "is this row checked."
  const isChecked = (entry) => selectedIds.some(s =>
    entry.type === 'folder' ? (s.type === 'folder' && s.path === entry.path) : (s.type === 'file' && s.id === entry.id))
  const toggleChecked = (entry) => {
    const exists = isChecked(entry)
    const next = exists
      ? selectedIds.filter(s => entry.type === 'folder' ? !(s.type === 'folder' && s.path === entry.path) : !(s.type === 'file' && s.id === entry.id))
      : [...selectedIds, entry]
    patchState({ selectedIds: next })
  }

  for (const folder of folders) {
    const row = document.createElement('div')
    row.className = 'file-row folder-row'
    const folderEntry = { type: 'folder', path: folder.path, name: folder.name }
    // SELECT MANY (Apple C, 2026-09-17): "Files and folders in the
    // current place can be checked." In select mode, a checkbox
    // replaces the row's normal navigate-in click target for the
    // checkbox itself only -- the row's OWN name/icon area still
    // navigates in on click (checking a folder for a bulk Move/Delete
    // and entering it are two different intents; Apple's Photos app
    // keeps both live at once in Select mode the same way).
    const checkboxHtml = selectMode
      ? '<input type="checkbox" class="row-checkbox" ' + (isChecked(folderEntry) ? 'checked' : '') + '>'
      : ''
    row.innerHTML =
      checkboxHtml +
      '<div class="file-info">' +
        '<span class="folder-icon">\u{1F4C1}</span>' +
        '<span class="file-name">' + esc(folder.name) + '</span>' +
      '</div>' +
      (selectMode ? '' :
        '<button class="btn btn-ghost btn-folder-rename" title="Rename folder" data-path="' + esc(folder.path) + '">\u270F\uFE0F</button>' +
        '<button class="btn btn-ghost btn-folder-delete" title="Delete folder" data-path="' + esc(folder.path) + '">\u{1F5D1}\uFE0F</button>')
    if (selectMode) {
      row.querySelector('.row-checkbox').addEventListener('click', (e) => { e.stopPropagation(); toggleChecked(folderEntry) })
    }
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
    // SELECT MANY (Apple C, 2026-09-17): these two per-row buttons are
    // simply not rendered at all in select mode (see checkboxHtml
    // branch above) -- "Rename stays one item," so a folder's own
    // rename affordance staying single-item-only outside select mode
    // is unchanged; querySelector calls below are skipped entirely
    // when selectMode hid the buttons.
    if (!selectMode) {
      row.querySelector('.btn-folder-rename').addEventListener('click', (e) => {
        e.stopPropagation()
        onRenameFolder(folder.path, folder.name)
      })
      row.querySelector('.btn-folder-delete').addEventListener('click', (e) => {
        e.stopPropagation()
        onDeleteFolder(folder.path, folder.name)
      })
    }
    // DROP TARGET (Apple A, 2026-09-16): "Drop an already-listed file
    // onto a folder row: same move, not a new upload." AND "Drop a
    // desktop File onto a folder row: Add into that folder." Both
    // land on this same row -- the drop handler below distinguishes
    // by dataTransfer contents (internal drag carries our own
    // text/x-tessera-file-id type; an OS drop carries real
    // e.dataTransfer.files).
    // OS FOLDER DROP (Apple C, 2026-09-17): a directory dropped onto a
    // folder row is handled by the SAME entry point as a directory
    // dropped onto the main dropzone -- enqueueOsEntries() below reads
    // e.dataTransfer.items via webkitGetAsEntry itself and only falls
    // back to the plain-Files branches here when the browser has no
    // directory-entry API at all (see that function's own comment).
    row.addEventListener('dragover', (e) => {
      e.preventDefault()
      row.classList.add('folder-drop-target')
    })
    row.addEventListener('dragleave', () => row.classList.remove('folder-drop-target'))
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      row.classList.remove('folder-drop-target')
      if (e.dataTransfer.items && e.dataTransfer.items.length && enqueueOsEntries(e.dataTransfer.items, folder.path)) return
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
    const fileEntry = { type: 'file', id: f.id }
    row.className = 'file-row' + (!selectMode && realIdx === selectedIdx ? ' selected' : '') + (selectMode && isChecked(fileEntry) ? ' selected' : '')
    row.draggable = !selectMode
    // Stable lookup key for re-finding THIS row after a re-render -- see
    // the click handler below (2026-09-21, "tessera-web-menu-topleft").
    row.dataset.fileId = f.id
    const checkboxHtml = selectMode
      ? '<input type="checkbox" class="row-checkbox" ' + (isChecked(fileEntry) ? 'checked' : '') + '>'
      : ''
    row.innerHTML =
      checkboxHtml +
      '<div class="file-info">' +
        '<span class="file-name">' + esc(f.displayName) + '</span>' +
        '<span class="file-meta">' + esc(fmtDateTime(f.updatedAt)) + '</span>' +
      '</div>' +
      '<span class="file-size">' + esc(formatBytes(f.size)) + '</span>'
    if (selectMode) {
      // SELECT MANY (Apple C, 2026-09-17): the WHOLE row toggles the
      // checkbox in select mode (not just the tiny checkbox target) --
      // same "tap items" affordance Apple's own Select mode uses,
      // rather than forcing a precise tap on an 18px box.
      row.addEventListener('click', () => toggleChecked(fileEntry))
    } else {
      // FILE MENU (2026-09-19, "tessera-web-file-menu"): clicking a row
      // still sets selectedIdx (unchanged -- selectedFile()/the
      // subscribe('selectedIdx', ...) enable-disable logic on the old
      // #fileActions buttons still runs, since this menu's own items
      // call those exact same handlers) AND now also opens the popup
      // menu anchored to this row. Re-clicking the ALREADY-selected row
      // toggles the menu closed instead of re-opening it in place --
      // same "click again to dismiss" affordance a desktop list menu
      // gives, per the packet's own "same idea as a desktop list menu."
      row.addEventListener('click', () => {
        const already = getState().selectedIdx === realIdx && !r.fileMenu.classList.contains('hidden')
        // BUG (2026-09-21, "tessera-web-menu-topleft", operator report:
        // "action buttons... blocked top/left"): patchState() below
        // notifies its 'selectedIdx' listener SYNCHRONOUSLY (store.js's
        // own patchState loops and calls listeners in the same tick,
        // no microtask/rAF hop), and that listener calls
        // renderFileList(), which does `fileList.innerHTML = ''` and
        // rebuilds every row from scratch. That DESTROYS this exact
        // `row` element -- passing the now-detached closure variable to
        // openFileMenu() below made positionFileMenu()'s
        // `anchorRow.getBoundingClientRect()` return an all-zero rect
        // (a detached node has no layout box), which is exactly why the
        // menu always opened pinned to (0,0) regardless of which file
        // was clicked. Re-find the FRESHLY rendered row for this same
        // file by its stable data-file-id (set above) after the
        // re-render runs, rather than trusting the pre-render closure.
        patchState({ selectedIdx: realIdx })
        if (already) { closeFileMenu(); return }
        const freshRow = r.fileList.querySelector('[data-file-id="' + f.id + '"]')
        openFileMenu(freshRow || row)
      })
      // DRAG SOURCE (Apple A, 2026-09-16): "Drop an already-listed file
      // onto a folder row: same move." Carries only the file's real id
      // (its own metadata.name full path is looked up fresh from state
      // in moveFileTo() at drop time, never trusted from a stale drag
      // payload) via a custom MIME type that no OS drag ever produces,
      // so the drop handler above can tell "our own row" apart from a
      // real desktop-file drop unambiguously. Draggable is off in
      // select mode (row.draggable above) so a checkbox tap can never
      // be misread as a drag start.
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-tessera-file-id', f.id)
        e.dataTransfer.effectAllowed = 'move'
      })
    }
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

// ── select many (Apple C, 2026-09-17) ────────────────────
//
// LAW: "A Select control on the Files list (Apple: Select, tap items,
// action at the bottom). Files and folders in the current place can be
// checked. Select all in this place is allowed. With a selection: Move
// and Delete work on the set. Rename stays one item." A SEPARATE
// selection model from selectedIdx/fileActions (store.js's own comment
// on selectMode/selectedIds explains why) -- entering select mode does
// not touch or clear the single-item selection underneath it.

function onEnterSelectMode() {
  patchState({ selectMode: true, selectedIds: [] })
}

function onExitSelectMode() {
  patchState({ selectMode: false, selectedIds: [] })
}

// onSelectAllInPlace(): "Select all in this place is allowed." Checks
// every folder AND file currently visible in computeFolderView()'s
// result for currentPath -- the exact same query renderFileList() just
// used to paint the rows being selected, so "all" can never mean a
// different set than what's on screen.
function onSelectAllInPlace() {
  const { files, currentPath } = getState()
  const { folders, files: fileRows } = computeFolderView(files, currentPath, getVirtualFolders())
  const all = [
    ...folders.map(f => ({ type: 'folder', path: f.path, name: f.name })),
    ...fileRows.map(f => ({ type: 'file', id: f.id })),
  ]
  patchState({ selectedIds: all })
}

// onSelectManyMove(): reuses the EXACT same Move modal Apple A built
// (r.moveModal/r.moveModalList) -- no second destination picker
// invented. "Each file is metadata rewrite. A selected folder moves by
// rewriting every object under it (same prefix swap as rename)."
// "Collision at dest: name (1).ext on files. Sibling folder name
// clash: refuse that folder with one sentence, do not invent
// Photos (1)." -- checked PER TARGET at move time (fresh file list
// after each step), matching how onMove/moveFileTo already do single-
// file collision checks one at a time rather than pre-computing a
// batch plan that could go stale mid-move.
function onSelectManyMove() {
  const { selectedIds } = getState()
  if (!selectedIds.length) return  // "Empty selection: Move/Delete do nothing."
  const { files } = getState()
  const allFolders = computeAllFolderPaths(files, getVirtualFolders())
  r.moveModalList.innerHTML = ''
  const rootRow = document.createElement('div')
  rootRow.className = 'move-modal-row'
  rootRow.textContent = 'Root'
  rootRow.addEventListener('click', () => { closeMoveModal(); moveSelectedTo('') })
  r.moveModalList.appendChild(rootRow)
  for (const path of allFolders) {
    const row = document.createElement('div')
    row.className = 'move-modal-row'
    row.textContent = path
    row.addEventListener('click', () => { closeMoveModal(); moveSelectedTo(path) })
    r.moveModalList.appendChild(row)
  }
  r.moveModal.classList.remove('hidden')
}

// moveSelectedTo(destPath): moves the whole current selectedIds set to
// destPath, one target at a time. Files go through moveFileToQuiet()
// (moveFileTo()'s own logic, split so it can run in a loop without
// each step's own toast/refresh firing mid-batch). A selected FOLDER
// moves by rewriting every real object under it, same prefix-swap
// renameObjectPath() already uses for folder Rename (Apple B) -- reuses
// renameFilePath()'s own path-swap helper, not a new rewrite mechanism.
// "Sibling folder name clash: refuse that folder with one sentence, do
// not invent Photos (1)" -- checked against the DESTINATION's existing
// folders before touching any object for that folder; a refused folder
// is skipped (its files untouched) while every OTHER item in the
// selection still proceeds, and the one sentence names which folder was
// skipped and why.
async function moveSelectedTo(destPath) {
  const sdk = getState().sdk; if (!sdk) return
  const { selectedIds } = getState()
  if (!selectedIds.length) return
  setBusy(true); patchState({ status: 'Moving\u2026' })
  const skippedFolders = []
  try {
    for (const entry of selectedIds) {
      if (entry.type === 'file') {
        await moveFileToQuiet(entry.id, destPath)
        continue
      }
      // entry.type === 'folder'
      const { files: curFiles } = getState()
      const { folders: destFolders } = computeFolderView(curFiles, destPath, getVirtualFolders())
      if (destFolders.some(f => f.name === entry.name)) {
        skippedFolders.push(entry.name)
        continue
      }
      const newPath = buildPath(destPath, entry.name)
      if (newPath === entry.path) continue  // no-op move (already there)
      const targets = filesUnderFolder(curFiles, entry.path)
      for (const f of targets) {
        const newFullName = renameFilePath(f.name, entry.path, newPath)
        await renameObjectPath(sdk, f.id, newFullName)
      }
      renameVirtualFolderPrefix(entry.path, newPath)
      await refreshFiles()
    }
    await refreshFiles()
    patchState({ status: '', selectedIds: [], selectMode: false })
    renderBreadcrumb()
    if (skippedFolders.length) {
      showToast('\u26A0\uFE0F Moved, but skipped: ' + skippedFolders.join(', ') + ' (already exists there)')
    } else {
      showToast('\u{1F4C1} Moved ' + selectedIds.length + ' item' + (selectedIds.length === 1 ? '' : 's'))
    }
  } catch (e) {
    patchState({ status: 'Could not move everything. Try again.' })
    console.error(e)
  } finally { setBusy(false) }
}

// moveFileToQuiet(objectId, destPath): moveFileTo()'s own rename-with-
// collision logic, split out so a batch move (moveSelectedTo above)
// can call it in a loop without each individual file firing its own
// toast/status/refresh mid-batch -- the caller does exactly one status
// line and one refresh for the whole set instead, per the packet's own
// "one status sentence" convention used elsewhere (folder rename,
// folder delete).
async function moveFileToQuiet(objectId, destPath) {
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
  await renameObjectPath(sdk, objectId, newFullName)
}

// onSelectManyDelete(): "One confirm that names the damage. 'Delete N
// items?' is enough if only files. If folders are in the set: 'Delete N
// items including folders and their files?' Cancel keeps everything."
// N here is the SELECTED ENTRY count (folders count as 1 entry each in
// N, matching the packet's own "Delete N items" wording -- distinct
// from onDeleteFolder's single-folder confirm, which counts the files
// INSIDE that one folder instead; this is the top-level "how many things
// did you check" number).
function onSelectManyDelete() {
  const { selectedIds } = getState()
  if (!selectedIds.length) return  // "Empty selection: Move/Delete do nothing."
  const n = selectedIds.length
  const hasFolders = selectedIds.some(s => s.type === 'folder')
  const question = hasFolders
    ? 'Delete ' + n + ' item' + (n === 1 ? '' : 's') + ' including folders and their files?\n\nThis cannot be undone.'
    : 'Delete ' + n + ' item' + (n === 1 ? '' : 's') + '?\n\nThis cannot be undone.'
  if (!confirm(question)) return  // Cancel keeps everything -- no state touched above this line
  deleteSelected()
}

// deleteSelected(): "Confirm: deleteObject each file under each
// selected folder, then the selected files, then drop virtual paths.
// Gone is gone." Folders first (each folder's own files, via the same
// filesUnderFolder() query onDeleteFolder uses), then the directly
// selected files, then every virtual (empty) folder path is dropped in
// one pass at the end -- matching onDeleteFolder's own ordering,
// applied across the whole set instead of one folder at a time.
async function deleteSelected() {
  const sdk = getState().sdk; if (!sdk) return
  const { selectedIds } = getState()
  setBusy(true); patchState({ status: 'Deleting\u2026' })
  try {
    const { files } = getState()
    for (const entry of selectedIds) {
      if (entry.type !== 'folder') continue
      const targets = filesUnderFolder(files, entry.path)
      for (const f of targets) {
        await deleteFile(sdk, f.id)
      }
      const markerId = findFolderMarkerId(files, entry.path)
      if (markerId) await deleteFile(sdk, markerId)
    }
    for (const entry of selectedIds) {
      if (entry.type !== 'file') continue
      // A file already deleted as part of a selected folder's own
      // filesUnderFolder() sweep above would 404 here if it were also
      // independently checked -- not possible in practice (a file row
      // only ever renders once, under either its folder OR a listing
      // that already excludes folder-nested files per computeFolderView),
      // but deleteFile() failures are per-item and do not abort the
      // whole batch below regardless.
      await deleteFile(sdk, entry.id)
    }
    for (const entry of selectedIds) {
      if (entry.type === 'folder') removeVirtualFolderPrefix(entry.path)
    }
    await refreshFiles()
    patchState({ status: '', selectedIds: [], selectMode: false })
    showToast('\u{1F5D1}\uFE0F Deleted ' + selectedIds.length + ' item' + (selectedIds.length === 1 ? '' : 's'))
  } catch (e) {
    patchState({ status: 'Delete failed: ' + (e.message || 'error') })
    console.error(e)
  } finally { setBusy(false) }
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

// enqueueUploadIntoFolder(file, destPath, silent): "Drop a desktop File
// onto a folder row: that is Add into that folder (prefix + existing
// upload path). One occupy, same as Add." Queued the same way as a
// normal Add drop, but tagging this entry with its own destPath so
// processUploadQueue()/doUpload() compute metaName against the
// FOLDER the file was dropped on, not whatever folder happens to be
// open in the list at the time its turn comes up.
//
// silent (Apple C, 2026-09-17, OS folder drop): a bulk OS-folder drop
// queues many files back-to-back through this same function --
// without this flag, every single one past the first would fire its
// own "Queued: X (waiting for current upload)" toast, burying the
// batch's own single "Adding K files..." announcement (see
// enqueueBulkFiles below) under a toast storm. A plain one-file drop
// onto a folder row (the ORIGINAL Apple A behavior) is completely
// unaffected -- silent defaults to false/undefined, same toast as
// before this packet.
function enqueueUploadIntoFolder(file, destPath, silent) {
  _uploadQueue.push({ file, destPath })
  if (!silent && _uploadQueue.length > 1) {
    showToast('\u23F3 Queued: ' + file.name + ' (waiting for current upload)')
  }
  processUploadQueue()
}

// ── OS folder drop (Apple C, 2026-09-17) ──────────────────
//
// LAW: "Browser DataTransferItem.webkitGetAsEntry / directory entries,
// or webkitdirectory. Not a zip." "Create virtual paths for every
// folder in the drop that has no file yet. Queue each file as Add with
// destPath = currentFolder + relative path." "Status: 'Adding K
// files...' then the normal per-file encoding.../uploading (N/M) on
// the one that is shipping. Queue already serial." "Collision at dest:
// same (1) rule." "Ignore .DS_Store and Thumbs.db." "Cap this packet:
// 200 files in one drop. Over that: one sentence, add none."

const OS_DROP_MAX_FILES = 200
const OS_DROP_IGNORE_NAMES = new Set(['.DS_Store', 'Thumbs.db'])

// enqueueOsEntries(items, baseDestPath): entry point for BOTH the main
// dropzone and a folder-row drop (same function, different baseDestPath
// -- see both call sites). Returns true if it recognized at least one
// DIRECTORY entry in the drop and took over handling it (caller must
// not also run its own plain-Files fallback); returns false if nothing
// in the drop was a directory, so the caller's existing loose-file path
// runs completely unchanged -- "Dropping loose files onto Add stays as
// today."
function enqueueOsEntries(items, baseDestPath) {
  // webkitGetAsEntry() must be called synchronously, inside the
  // original drop event's own call stack -- browsers invalidate
  // DataTransferItem access on the next tick. Collect every top-level
  // entry FIRST (sync), then walk the tree async afterward.
  const topEntries = []
  let sawAnyEntry = false
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (typeof item.webkitGetAsEntry !== 'function') continue
    const entry = item.webkitGetAsEntry()
    if (entry) { sawAnyEntry = true; topEntries.push(entry) }
  }
  if (!sawAnyEntry) return false
  const hasDirectory = topEntries.some(e => e.isDirectory)
  if (!hasDirectory) return false  // every entry was a plain file -- let the caller's normal Files path handle it, unchanged
  walkAndQueueEntries(topEntries, baseDestPath)
  return true
}

// walkAndQueueEntries(topEntries, baseDestPath): recursively reads every
// directory entry (FileSystemDirectoryReader.readEntries() -- must be
// called repeatedly until it returns an empty array; a single call is
// NOT guaranteed to return everything, this is the browser API's own
// documented contract) and collects a flat list of
// { file, destPath } pairs before queuing anything, so the 200-file cap
// and "add none" refusal can be enforced BEFORE any upload starts.
async function walkAndQueueEntries(topEntries, baseDestPath) {
  const collected = []  // { file, destPath }
  const emptyDirPaths = []  // destPath strings with no files directly in them (candidates for virtual folder rows)
  let overCap = false

  function relDestPath(entry) {
    // entry.fullPath is like "/FolderName/sub/file.txt" (webkitGetAsEntry's
    // own leading-slash convention) -- strip the leading slash and the
    // entry's own basename to get the RELATIVE directory portion, then
    // prefix with baseDestPath ("currentFolder + relative path").
    const full = entry.fullPath.replace(/^\/+/, '')
    const slashIdx = full.lastIndexOf('/')
    const relDir = slashIdx === -1 ? '' : full.slice(0, slashIdx)
    return relDir ? buildPath(baseDestPath, relDir) : baseDestPath
  }

  async function readAllEntries(dirEntry) {
    const reader = dirEntry.createReader()
    const all = []
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) break
      all.push(...batch)
    }
    return all
  }

  async function walk(entry) {
    if (overCap) return
    if (entry.isFile) {
      if (OS_DROP_IGNORE_NAMES.has(entry.name)) return
      if (collected.length >= OS_DROP_MAX_FILES) { overCap = true; return }
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
      collected.push({ file, destPath: relDestPath(entry) })
      return
    }
    if (entry.isDirectory) {
      // "Create virtual paths for every folder in the drop that has no
      // file yet." Every directory gets recorded as a candidate here;
      // after the whole walk finishes, any candidate that never
      // received a file (still genuinely empty, e.g. a leaf folder
      // containing only ignored .DS_Store entries) gets a real virtual
      // folder row -- one that DID receive a file already gets a place
      // to live via that file's own upload, per computeFolderView()'s
      // real-object inference.
      const dirDestPath = buildPath(baseDestPath, entry.fullPath.replace(/^\/+/, ''))
      emptyDirPaths.push(dirDestPath)
      const children = await readAllEntries(entry)
      for (const child of children) {
        await walk(child)
        if (overCap) return
      }
    }
  }

  for (const entry of topEntries) {
    await walk(entry)
    if (overCap) break
  }

  if (overCap) {
    // "Cap this packet: 200 files in one drop. Over that: one sentence,
    // add none." -- nothing collected so far is queued; a partial add
    // of an arbitrary prefix of the drop would be a worse outcome than
    // a clean refusal.
    showToast('\u26A0\uFE0F Too many files in that folder (limit ' + OS_DROP_MAX_FILES + '). Nothing was added.')
    return
  }
  if (!collected.length) {
    showToast('That folder has no files to add.')
    return
  }

  // Virtual folder rows for genuinely empty directories only -- a path
  // that DID get a file queued below will already resolve as a real
  // folder once that file's own object exists (computeFolderView()'s
  // inference), so creating a redundant virtual row for it would be
  // harmless but pointless; skip it to keep tesseraweb.folders from
  // accumulating rows a real object already covers.
  const filedDestPaths = new Set(collected.map(c => c.destPath))
  for (const path of emptyDirPaths) {
    if (!filedDestPaths.has(path)) addVirtualFolder(path)
  }

  // "Status: 'Adding K files...' then the normal per-file
  // encoding.../uploading (N/M) on the one that is shipping. Queue
  // already serial." -- one status line announcing the whole batch,
  // then every file queues through the EXACT same
  // enqueueUploadIntoFolder()/processUploadQueue() path a single
  // folder-row drop already uses (silent=true so 199 of them don't each
  // fire their own "Queued: X" toast on top of this one announcement).
  showToast('\u23F3 Adding ' + collected.length + ' file' + (collected.length === 1 ? '' : 's') + '\u2026')
  for (const { file, destPath } of collected) {
    enqueueUploadIntoFolder(file, destPath, true)
  }
  renderFileList()
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
    // ONE ADD AT A TIME (2026-09-20, "tessera-web-add-overlap-stall"):
    // a genuinely QUEUED file (already accepted into _uploadQueue,
    // already toasted "Queued: ...") waits here on the REAL upload
    // lock -- files.js's own waitForUploadSlot() -- rather than
    // racing doUpload()'s own isRealUploadInFlight() guard, which
    // exists to reject an UNQUEUED second drop, not to eat a file
    // this app already promised to queue. By the time this resolves,
    // the prior real chain has genuinely settled, so doUpload()'s own
    // guard below is expected to pass through cleanly.
    await waitForUploadSlot()
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

// FAIL-CODE TABLE (2026-09-23, "tessera-web-fail-code"): the public
// page keeps the SAME four calm sentences as the 2026-09-19
// "tessera-web-add-fail-copy" packet -- only the tag after them
// changed, from a flat 4-way class to this packet's own 7-code
// vocabulary (T20/T20M/T0T/TWT/TR/T0P/T0) so the page/console can say
// whether the hole was tail-stall, mid-stall, zero-stall, pin, ready,
// connect, or SDK, per the packet's own requirement.
const FAIL_SENTENCE = {
  T20: 'Could not reach storage hosts. Please try again.',
  T20M: 'Could not reach storage hosts. Please try again.',
  T0T: 'Could not reach storage hosts. Please try again.',
  TWT: 'Could not connect to storage hosts. Check your network and try again.',
  TR: 'Storage is taking longer than expected. Please try again.',
  T0P: 'Could not add this file. Try again.',
  T0: 'Could not add this file. Try again.',
}
// files.js's own shard-stall watchdog Error message (line ~1266) --
// matched verbatim below, same as the prior packet's 'stall' class.
const STALL_WATCHDOG_MSG = 'Could not reach storage hosts. Please try again.'
// Codes that carry N/M on the page per the packet's own table; TWT/
// TR/T0P are bare (no shard count applies to a pre-shard or post-M
// failure).
const CODES_WITH_NM = new Set(['T20', 'T20M', 'T0T', 'T0'])

function buildFailTag(code, shardsLanded, expectedShards) {
  if (!CODES_WITH_NM.has(code)) return ' (' + code + ')'
  const n = typeof shardsLanded === 'number' ? shardsLanded : 0
  const m = typeof expectedShards === 'number' ? expectedShards : '?'
  return ' (' + code + ' ' + n + '/' + m + ')'
}

// SWALLOW FIX (2026-09-19, "tessera-web-add-fail-copy"; REVISED
// 2026-09-23 "tessera-web-fail-code" to the 7-code table above) maps
// a thrown Error from uploadFile()/waitForReady() to one of the codes
// in FAIL_SENTENCE. `sawShards` (doUpload's sawRealShardProgress),
// `shardsLanded` and `expectedShards` (both read back from
// uploadFile()'s own `marks` object -- no new signal, no extra
// hosts() call) are the only state used to tell the codes apart;
// there is no message string common to every possible sdk.upload()
// handshake/network rejection to match on instead (confirmed: the
// wasm SDK's own transport-open failures are opaque, non-uniform
// strings -- see the 2026-09-19 packet's recon).
function classifyAddFailure(e, sawShards, shardsLanded, expectedShards) {
  const msg = (e && e.message) || ''
  const landed = typeof shardsLanded === 'number' ? shardsLanded : 0
  const M = typeof expectedShards === 'number' ? expectedShards : null

  // TR: waitForReady()'s own cap-exceeded throw (files.js line
  // ~1323), fixed prefix regardless of the timeoutMs value passed in.
  // Always fires with landed===0 -- doUpload's own
  // `await waitForReady(sdk, 10000)` runs before uploadFile() (and
  // therefore before any shard) is ever called.
  if (msg.indexOf('Account not ready after') === 0) return 'TR'

  // T0P: M/M already landed by the time this threw. shardsFullyLanded
  // (files.js) is the sole gate for both remaining post-shard awaits
  // (the pin-stall timeout's own message, or sdk.pinObject() itself
  // throwing) -- and the shard-stall watchdog explicitly stops
  // rejecting once shardsFullyLanded flips true (see its own
  // WATCHDOG DISARM comment), so landed>=M can only mean a pin/
  // finalize failure here, regardless of e.message's exact text.
  if (M != null && landed >= M) return 'T0P'

  // T20 / T20M / T0T: files.js's own STALL_MS/TAIL_STALL_MS watchdog
  // throws this SAME message (line ~1266) whichever budget picked it
  // -- isTailZone() (imported from files.js, the exact predicate
  // stallBudgetMs() already applies) is what tells the three apart,
  // per this packet's own table. "Do not invent a second tail rule":
  // this reads the ONE threshold the timer itself uses, never a
  // second, independently-derived one.
  if (msg === STALL_WATCHDOG_MSG) {
    if (landed === 0) return 'T20'
    return (M != null && isTailZone(landed, M)) ? 'T0T' : 'T20M'
  }

  // TWT: either the tunnel-unavailable throw (Drop's shimmed path
  // only, window.___wtpoly___ gate -- files.js line ~901-903) matched
  // by substring, or any other throw that reached here with
  // sawRealShardProgress still false -- i.e. sdk.upload() itself
  // failed (handshake/network) before a single shard landed.
  if (msg.indexOf('File storage is temporarily unavailable') === 0) return 'TWT'
  if (!sawShards) return 'TWT'

  // T0: anything else -- a throw mid-slab (some shards landed, fewer
  // than M) that was NOT the stall watchdog's own message.
  return 'T0'
}

// ADD STAGE CLOCKS (2026-09-20, "tessera-web-add-timing"): "Instrument
// only... Clocks first." One console.info line per Add, exact prefix
// `tessera-add-time` so the operator can filter DevTools by it, plus
// the same object pushed onto window.__tesseraAddTimes (cap 20, no
// localStorage, no network beacon -- per this packet's own law).
// Marks come from two sources: t0/t_done are set HERE (doUpload() is
// the cited Add-start/Add-end per this packet's own "Add start = the
// moment this file enters doUpload()" instruction); t_encode/t_first/
// t_last/t_upload_ok/t_pin_start/t_pin_ok are set inside files.js's
// uploadFile() (the only place that can see those moments) and handed
// back via the existing onProgress callback's new `marks` field --
// no new callback, no second signal, no extra hosts() call.
window.__tesseraAddTimes = window.__tesseraAddTimes || []

function printAddTime(t0, marks, okTag, expectedShards) {
  const t_done = Date.now()
  const g = (k) => (marks && typeof marks[k] === 'number') ? marks[k] : null
  const t_encode = g('t_encode'), t_first = g('t_first'), t_last = g('t_last')
  const t_upload_ok = g('t_upload_ok'), t_pin_start = g('t_pin_start'), t_pin_ok = g('t_pin_ok')
  // SHARDS FIELD (2026-09-20, "tessera-web-add-overlap-stall"): "Add
  // shards=N/M (landed/expected at paint)." landed comes from the
  // SAME marks object the other clocks already use (files.js's own
  // onShardUploaded sets marks.shardsLanded on every shard) -- no new
  // signal, just a field that already existed and was never surfaced
  // on this line before. M is always the same expectedShards this
  // line already prints as `slabs`, not re-derived.
  const shardsLanded = (marks && typeof marks.shardsLanded === 'number') ? marks.shardsLanded : 0
  const shardsStr = shardsLanded + '/' + (typeof expectedShards === 'number' ? expectedShards : '?')
  // Derived fields, per the packet's own formulas -- `-` when either
  // side of a subtraction never fired (a fail path may be missing
  // t_last/t_upload_ok/etc depending on where it threw).
  const diff = (a, b) => (typeof a === 'number' && typeof b === 'number') ? (a - b) : null
  const us_pre = diff(t_first, t0)
  const ship = diff(t_last, t_first)
  const close = diff(t_upload_ok, t_last)
  const pin = (typeof t_pin_start === 'number' && typeof t_pin_ok === 'number') ? (t_pin_ok - t_pin_start) : (t_pin_start != null ? null : 0)
  const us_post = diff(t_done, t_last)
  const us = (us_pre != null && us_post != null) ? (us_pre + us_post) : null
  const total = t_done - t0
  const slabs = (typeof expectedShards === 'number' && expectedShards > 0 && expectedShards % 30 === 0) ? (expectedShards / 30) : '-'
  const fmt = (v) => (v === null || v === undefined) ? '-' : v
  const row = {
    ok: okTag, slabs, shards: shardsStr,
    us_pre: fmt(us_pre), us: fmt(us), ship: fmt(ship), close: fmt(close), pin: fmt(pin), us_post: fmt(us_post), total,
    t_encode: fmt(t_encode), t_first: fmt(t_first), t_last: fmt(t_last),
    t_upload_ok: fmt(t_upload_ok), t_pin_start: fmt(t_pin_start), t_pin_ok: fmt(t_pin_ok), t_done,
  }
  console.info(
    'tessera-add-time ok=' + row.ok + ' slabs=' + row.slabs + ' shards=' + row.shards +
    ' us_pre=' + row.us_pre + ' us=' + row.us + ' ship=' + row.ship + ' close=' + row.close +
    ' pin=' + row.pin + ' us_post=' + row.us_post + ' total=' + row.total +
    ' t_encode=' + row.t_encode + ' t_first=' + row.t_first + ' t_last=' + row.t_last +
    ' t_upload_ok=' + row.t_upload_ok + ' t_pin_start=' + row.t_pin_start + ' t_pin_ok=' + row.t_pin_ok +
    ' t_done=' + row.t_done
  )
  window.__tesseraAddTimes.push(row)
  if (window.__tesseraAddTimes.length > 20) window.__tesseraAddTimes.shift()
  // LAST-TICK HOST TRACE (2026-09-20, "tessera-web-29-of-30"): "the
  // last 3 ticks: i= host=" -- a SECOND console line (not appended to
  // tessera-add-time itself, keeping that line's own fixed shape
  // untouched) so a failed Add's console shows which host(s) never
  // reported the final shard. marks.lastTicks is files.js's own
  // capped-at-3 array (ShardProgress.shardIndex/hostKey, confirmed
  // fields per that packet's .d.ts citation) -- no new hosts() call,
  // purely a readback of ticks the write already produced.
  const lastTicks = (marks && Array.isArray(marks.lastTicks)) ? marks.lastTicks : []
  const shardStr = lastTicks.map((t) => 'i=' + fmt(t.i) + ' host=' + fmt(t.host)).join(' | ')
  console.info('tessera-add-shard ' + (shardStr || '(no shards landed)'))
  // OPTIONAL SUMMARY SENTENCE (packet section 2, "Optional"): one quiet
  // line under the progress row, same family/size as status text, no
  // raw JSON. Only painted when both halves are known -- ship/us both
  // `-` on a fail-before-any-shard would otherwise print a useless
  // "-s ship -s / us -s" line; better to show nothing than that.
  if (typeof ship === 'number' && typeof us === 'number') {
    r.statusText.textContent = (ship / 1000).toFixed(1) + 's ship ' + (us / 1000).toFixed(1) + 's / us ' + (us / 1000).toFixed(1) + 's'
  }
}

async function doUpload(file, destPathOverride) {
  const sdk = getState().sdk; if (!sdk) return
  // ONE ADD AT A TIME (2026-09-20, "tessera-web-add-overlap-stall"):
  // "Until the current Add reaches success paint or a T-tag fail
  // paint: Drop/Add/queue start must not call sdk.upload() again."
  // isRealUploadInFlight() is files.js's own real-lock flag -- true
  // from the moment a WASM-path upload's real sdk.upload() call is
  // made until its real chain (upload + pin) genuinely settles,
  // regardless of what any watchdog race in a PRIOR doUpload() call
  // did. This is a defense-in-depth guard on TOP of the real lock
  // uploadFile() itself now enforces (see files.js's own top-of-
  // uploadFile SERIAL LOCK comment) -- that lock alone is sufficient
  // to prevent a second real sdk.upload() call from ever firing, but
  // checking here too means a second drop gets the packet's own
  // required quiet sentence immediately, instead of silently sitting
  // in the processUploadQueue() array waiting on a lock it can't see.
  if (isRealUploadInFlight()) {
    patchState({ status: 'Already adding a file.' })
    return
  }
  // ADD STAGE CLOCKS: t0 is cited by this packet as "the moment this
  // file enters doUpload()" -- the very first line of this function,
  // before setBusy/reset/anything else below runs.
  const addT0 = Date.now()
  let addMarks = null
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
  // BAR-TO-ZERO-AT-START (2026-09-19, "tessera-web-bar-zero"): "When a
  // new upload starts, the progress bar must go to zero immediately."
  // Previously the bar/wrap were left completely untouched here (see
  // the REMOVED note just below, still accurate for the `patchState`
  // part) -- so a bar left at 100% from the PREVIOUS successful Add
  // (doUpload's own success path sets exactly this: renderProgressBar
  // (100) + progressWrap still unhidden, see the SUCCESS LINE comment
  // further down) stayed painted at full width through drop, the Ready
  // wait, and the entire 'encoding...' phase -- only the first REAL
  // onShardUploaded tick's setProgressTarget(percent) call ever touched
  // the bar's width again. Explicit reset right here, before any of
  // that, guarantees a fresh Add always starts from a genuine zero-
  // width bar, never the previous job's full one. stopEncodingAnim()
  // guards the same "a still-running previous animation timer" case
  // stopEase() already guards for the ease timer -- both are already
  // idempotent no-ops if nothing is running.
  stopEncodingAnim()
  renderProgressBar(0)
  r.progressWrap.classList.remove('hidden')
  r.progressLabel.textContent = ''
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
  //
  // REVISED (2026-09-19, "tessera-web-bar-zero"): the bar/wrap ARE now
  // explicitly reset above -- what remains true from the ORIGINAL note
  // is that no PLACEHOLDER STATUS STRING (like the old 'Preparing...')
  // is set; status stays '' below exactly as before. The "no bar
  // visible before ship" law from 2026-09-16 has been superseded by
  // this packet's explicit instruction: show the wrap immediately, at
  // zero width, so the previous job's full bar can never be seen
  // through this window -- the two laws would conflict on a repeat Add
  // otherwise, and this packet's own reproduction ("previous job's
  // full bar sitting there during the first status word") is exactly
  // that conflict.
  patchState({ status: '' })
  // SWALLOW FIX (2026-09-19, "tessera-web-add-fail-copy"): tracks whether
  // any REAL shard-landed tick was ever seen for this Add attempt (the
  // `else` branch below, after the 'encoding...' branch returns) -- not
  // reset by anything else. Used only in the catch below to distinguish
  // "failed before any shard" (connect class) from "failed after shards
  // were already landing" (generic class, includes pin/finalize
  // failures) -- see the catch's own comment for why a structural check
  // like this is used instead of string-matching the SDK's own opaque
  // WebTransport error text.
  let sawRealShardProgress = false
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
    await uploadFile(sdk, file, ({ stage, percent, elapsed, hostKey, transferMs, marks }) => {
      // ADD STAGE CLOCKS: every tick (encoding included) carries the
      // SAME marks object reference from files.js -- captured here on
      // every call so whichever tick happens to be the LAST one before
      // success/fail always has the freshest values, with no separate
      // "final tick" bookkeeping needed.
      if (marks) addMarks = marks
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
      // SWALLOW FIX (2026-09-19, "tessera-web-add-fail-copy"): every tick
      // that reaches this branch (anything past the 'encoding...' guard
      // above) is real onShardUploaded/pinning/done progress -- see
      // doUpload's own sawRealShardProgress declaration above.
      sawRealShardProgress = true
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
    // ADD STAGE CLOCKS: printed here, ok=yes, after every real mark
    // this Add could produce has already fired (encode/first/last/
    // upload_ok/pin_start/pin_ok all happen before uploadFile()
    // resolves, and this line runs immediately after that await).
    printAddTime(addT0, addMarks, 'yes', addMarks ? addMarks.expectedShards : null)
    // DEBUG DIARY (2026-09-24, "tessera-web-debug-log"): "Add end: ok or
    // code, shards N/M, elapsed_ms." bag_n/bag list are read back from
    // addMarks.bagHosts (files.js's own in-hand hostKey set, built purely
    // from onShardUploaded events this Add already saw -- never a fresh
    // hosts() call); bag=- when nothing landed at all.
    {
      const m = addMarks ? addMarks.expectedShards : null
      const n = (addMarks && typeof addMarks.shardsLanded === 'number') ? addMarks.shardsLanded : 0
      const bag = (addMarks && addMarks.bagHosts && addMarks.bagHosts.size)
        ? Array.from(addMarks.bagHosts).map(hex8).join(',')
        : '-'
      const bagN = (addMarks && addMarks.bagHosts) ? addMarks.bagHosts.size : 0
      // BAG PERSISTENCE (2026-09-26, "tessera-web-debug-dl"): keep the
      // last Add's real in-hand host Set alive on window past this
      // function's own return, so a LATER Download in the same tab can
      // cite it ("bag= from memory already held this tab") without
      // downloadToDisk() ever calling hosts() itself. Full keys only
      // (never truncated here) -- files.js's own hex8() is applied at
      // the read site, same as every other bag-consumer in this file.
      if (addMarks && addMarks.bagHosts && addMarks.bagHosts.size) {
        window.__tesseraLastAddBagHosts = addMarks.bagHosts
      }
      diaryPush(
        'add-end ok shards=' + n + '/' + (m != null ? m : '?') +
        ' elapsed_ms=' + (Date.now() - addT0) +
        ' bag_n=' + bagN + ' bag=' + bag
      )
    }
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
      // DEBUG DIARY (2026-09-26, "tessera-web-debug-dl"): "list-fail --
      // files list fetch threw (no object names)." e.message only, no
      // object names/paths.
      diaryPush('list-fail err=' + String(e.message || e).slice(0, 80))
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
    // SWALLOW FIX (2026-09-19, "tessera-web-add-fail-copy"; REVISED
    // 2026-09-23 "tessera-web-fail-code"): the OLD code below this
    // comment used to overwrite EVERY throw with the same generic
    // sentence, no matter which throw path in uploadFile()/
    // waitForReady() actually fired -- "stall", "ready cap", and
    // "sdk.upload() itself" all landed on one indistinguishable
    // string. classifyAddFailure() (top of file) now maps e.message
    // + shard progress to one of the 7 codes in this packet's own
    // table (T20/T20M/T0T/TWT/TR/T0P/T0) -- see that function's own
    // comment for the full per-code rationale.
    const shardsLandedAtFail = (addMarks && typeof addMarks.shardsLanded === 'number') ? addMarks.shardsLanded : 0
    const expectedShardsAtFail = addMarks ? addMarks.expectedShards : null
    const failCode = classifyAddFailure(e, sawRealShardProgress, shardsLandedAtFail, expectedShardsAtFail)
    const tag = buildFailTag(failCode, shardsLandedAtFail, expectedShardsAtFail)
    renderProgressBar(0)
    r.progressLabel.textContent = FAIL_SENTENCE[failCode] + tag
    // ADD STAGE CLOCKS: okTag is now exactly this packet's own 7-code
    // vocabulary (T20/T20M/T0T/TWT/TR/T0P/T0), the SAME string the
    // fail path just painted on the page (stripped of its N/M suffix
    // and parens) -- no separate stripping step needed since
    // classifyAddFailure() already returns the bare code.
    const okTag = failCode
    printAddTime(addT0, addMarks, okTag, addMarks ? addMarks.expectedShards : null)
    // CONSOLE FAIL BLOCK (2026-09-23, "tessera-web-fail-code" section
    // 2): "On every Add fail, console.error ONE block the operator
    // can copy... Exact prefix `tessera-add-fail` so a search still
    // works." quiet_ms reads back marks.lastProgressAt (the SAME
    // clock the shard-stall watchdog already maintains in files.js,
    // exposed onto marks -- no second clock); last_i/last_host read
    // the last entry of marks.lastTicks (files.js's own capped-at-3
    // shard trace, unchanged). Host URLs inside e.message (if any)
    // are already visible in the browser's own network panel per
    // this packet's law, so they are allowed to pass through in
    // `raw` here unredacted; no phrase/AppKey/cookie/vault value is
    // ever logged by this function.
    const lastTicks = (addMarks && Array.isArray(addMarks.lastTicks)) ? addMarks.lastTicks : []
    const lastTick = lastTicks.length ? lastTicks[lastTicks.length - 1] : null
    const quietMs = (addMarks && typeof addMarks.lastProgressAt === 'number') ? (Date.now() - addMarks.lastProgressAt) : '-'
    const mStr = typeof expectedShardsAtFail === 'number' ? expectedShardsAtFail : '?'
    console.error(
      'tessera-add-fail code=' + failCode + ' shards=' + shardsLandedAtFail + '/' + mStr + '\n' +
      'quiet_ms=' + quietMs + ' last_i=' + (lastTick && lastTick.i != null ? lastTick.i : '-') +
      ' last_host=' + (lastTick && lastTick.host ? lastTick.host : '-') + '\n' +
      'raw=' + (e && e.message)
    )
    // DEBUG DIARY (2026-09-24, "tessera-web-debug-log"): "fail code +
    // quiet_ms + last_i + last_host (full key in the copy, 8-hex on the
    // pane)" + "Add end: ok or code, shards N/M, elapsed_ms." Same
    // fields the console block above just printed, split into a
    // pane-safe (8-hex) line and a Copy-only (full key) line via
    // diaryPush()'s own two-argument form.
    {
      const bag = (addMarks && addMarks.bagHosts && addMarks.bagHosts.size)
        ? Array.from(addMarks.bagHosts).map(hex8).join(',')
        : '-'
      const bagN = (addMarks && addMarks.bagHosts) ? addMarks.bagHosts.size : 0
      // BAG PERSISTENCE (2026-09-26, "tessera-web-debug-dl"): a bag can
      // exist even on a failed Add (partial shards landed before the
      // fail) -- persist it the same way the ok branch above does, so
      // a later Download still has something real to cite.
      if (addMarks && addMarks.bagHosts && addMarks.bagHosts.size) {
        window.__tesseraLastAddBagHosts = addMarks.bagHosts
      }
      const lastHostFull = (lastTick && lastTick.host) ? lastTick.host : '-'
      const lastHost8 = hex8(lastTick && lastTick.host)
      diaryPush(
        'add-end fail code=' + failCode + ' shards=' + shardsLandedAtFail + '/' + mStr +
        ' elapsed_ms=' + (Date.now() - addT0) +
        ' quiet_ms=' + quietMs +
        ' last_i=' + (lastTick && lastTick.i != null ? lastTick.i : '-') +
        ' last_host8=' + lastHost8 +
        ' bag_n=' + bagN + ' bag=' + bag,
        'add-end fail code=' + failCode + ' shards=' + shardsLandedAtFail + '/' + mStr +
        ' elapsed_ms=' + (Date.now() - addT0) +
        ' quiet_ms=' + quietMs +
        ' last_i=' + (lastTick && lastTick.i != null ? lastTick.i : '-') +
        ' last_host=' + lastHostFull +
        ' bag_n=' + bagN + ' bag=' + bag
      )
    }
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
  } finally { setBusy(false) }
}

async function onDownload() {
  const sf = selectedFile(); if (!sf) return
  const sdk = getState().sdk; if (!sdk) return
  setBusy(true)
  // RESET (2026-09-19, "tessera-web-download-progress"): "After a passed
  // upload the bar still says 'success!' and sits full. On Download,
  // that stale pass stays." doUpload() leaves r.progressLabel showing
  // '\u2705 Success!' and the bar at 100% (see doUpload's own SUCCESS
  // LINE comment, ~line 2296) with progressWrap still unhidden -- a
  // Download that follows immediately reused that exact same DOM state
  // with nothing here to clear it. stopEase()/stopEncodingAnim() guard
  // against any in-flight upload timer still running (same guards
  // doUpload's own catch block uses); renderProgressBar(0) + explicit
  // label text put the SAME progress row upload uses back to a genuine
  // zero state before this download's own first tick can arrive.
  stopEase()
  stopEncodingAnim()
  renderProgressBar(0)
  r.progressWrap.classList.remove('hidden')
  r.progressLabel.textContent = 'downloading (0%)'
  // Old status-line message REMOVED here on purpose -- the packet's
  // law is "do not put 'Downloading...' under the file list as the
  // only signal." r.statusText stays whatever it already was (usually
  // '') for this action; the progress row above is now the one and
  // only place Download shows live status, exactly matching Add's own
  // pattern (doUpload never writes to r.statusText for its own
  // in-flight progress either).
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
    await downloadToDisk(sdk, sf.id, sf.name, ({ hostKey, direction, transferMs, percent }) => {
      if (mapController && hostKey) mapController.landedHost(hostKey, direction, transferMs)
      // COPY (2026-09-19, "tessera-web-download-progress"): "downloading
      // (N%)" -- same family as upload's "uploading (N/M)", no word
      // "shards" per law. percent is always present on every tick
      // downloadToDisk() sends (0 at start, per-shard/whole-blob ticks
      // in between, 100 at genuine completion) -- never painted as a
      // guess ahead of what actually landed.
      if (typeof percent === 'number') {
        renderProgressBar(percent)
        r.progressLabel.textContent = 'downloading (' + percent + '%)'
      }
    })
    if (mapController) mapController.completeWrite()
    // DONE (2026-09-19, "tessera-web-download-progress"): "use one word
    // for both" -- doUpload's own success line is '\u2705 Success!'
    // (see its SUCCESS LINE comment above); reused verbatim rather than
    // inventing a second word for the same outcome. Bar full first
    // (downloadToDisk's own final percent:100 tick already did this,
    // repeated here defensively), then hidden the same way doUpload's
    // success path leaves it for the next action's 'encoding...' reset
    // to take over -- progressWrap stays unhidden briefly so this text
    // is visible, matching upload's own timing.
    renderProgressBar(100)
    r.progressLabel.textContent = '\u2705 Success!'
    showToast('\u2B07\uFE0F Downloaded: ' + sf.name)
  } catch (e) {
    if (mapController) mapController.completeWrite()
    // COPY (2026-09-15, "tessera-web-look-v1"): same "no stack trace"
    // treatment as Add failed -- one quiet sentence, real error only
    // to console. Per packet instruction 4 ("fail: existing calm
    // sentence. Do not leave a full green bar from the previous
    // upload") -- painted onto the SAME progress row the reset above
    // already claimed, at whatever percent the last real tick reached
    // (frozen, not forced to 0 or 100), mirroring doUpload's own fail
    // path (renderProgressBar(0) there is the exception it uses for
    // its OWN, different, fail case -- Download's law only asks that
    // stale success not persist, not that the fail bar move at all).
    r.progressLabel.textContent = 'Could not download this file. Try again.'
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
    // DEBUG DIARY (2026-09-26, "tessera-web-debug-dl"): "delete-end
    // fail|ok -- if you touch that catch anyway." 8-hex object id only,
    // never the filename (matches Download's own dl-start convention).
    diaryPush('delete-end ok obj=' + hex8(sf.id))
    await refreshFiles()
    patchState({ status: '' })
  } catch (e) {
    patchState({ status: 'Delete failed: ' + (e.message || 'error') })
    diaryPush('delete-end fail obj=' + hex8(sf.id) + ' err=' + String(e.message || e).slice(0, 80))
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

// ── debug pane (2026-09-24, "tessera-web-debug-log") ──────
//
// SWITCH: "Instrumented diary is on only when the page URL has query
// debug=1... Read the flag at boot and on popstate/in-app navigation so
// Back keeps the switch. Do not persist to localStorage. Do not persist
// to a cookie." syncDebugPane() is the single place that toggles
// #debugPane's own `.hidden` class -- called from wireEvents' popstate
// listener and enterFiles() (this file's own boot/nav sites), reading
// files.js's isDebugOn() live every time rather than caching the result
// anywhere, so the switch can never go stale against the URL.
function syncDebugPane() {
  const on = isDebugOn()
  r.debugPane.classList.toggle('hidden', !on)
  if (on) renderDebugPane()
}

// renderDebugPane(): paints window.__tesseraDebugDiary (files.js's own
// pane-safe, 8-hex-only array, already capped at 200 lines there) as
// newest-at-the-bottom text, then scrolls to the bottom. This is the
// repaint files.js calls through window.__tesseraDebugPaneRepaint every
// time it pushes a line -- see that file's own diaryPush()/diaryReset().
function renderDebugPane() {
  const lines = window.__tesseraDebugDiary || []
  r.debugLog.textContent = lines.join('\n')
  r.debugLog.scrollTop = r.debugLog.scrollHeight
}
window.__tesseraDebugPaneRepaint = renderDebugPane

// onDebugCopy(): "One click. Clipboard write of the full diary text. If
// Clipboard API is blocked, console.log the same blob and set the button
// label to Logged for 2s... Do not toast a fail for a clipboard deny."
// Copy reads the FULL-key array (window.__tesseraDebugDiaryFull), never
// the pane's own 8-hex array -- "Full ed25519:... keys may exist inside
// the copied text, not as visible row chrome."
async function onDebugCopy() {
  const text = (window.__tesseraDebugDiaryFull || window.__tesseraDebugDiary || []).join('\n')
  try {
    await navigator.clipboard.writeText(text)
  } catch (_) {
    console.log(text)
    const original = r.btnDebugCopy.textContent
    r.btnDebugCopy.textContent = 'Logged'
    setTimeout(() => { r.btnDebugCopy.textContent = original }, 2000)
  }
}

// ── Synced Folders (2026-09-29) ───────────────────────────
//
// Desktop-only: gives the desktop app the same folder-sync/watcher
// functionality as tessera-cli, by driving the bundled CLI binary over
// IPC (see cli-bridge.mjs) instead of re-implementing its tested
// three-way sync/reconcile/tombstone engine here in JS.

function defaultSyncPrefix(localPath) {
  const base = (localPath.split('/').pop() || localPath.split('\\').pop() || 'folder')
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'folder'
  return 'tessera/' + base
}

async function renderSyncFolders() {
  r.syncFolderList.innerHTML = '<p class="status-text">Loading&hellip;</p>'
  r.syncFoldersError.textContent = ''

  const [listRes, statusRes] = await Promise.all([
    window.tesseraDesktop.syncList(),
    window.tesseraDesktop.serviceStatus(),
  ])

  if (statusRes && statusRes.ok) {
    r.syncWatcherStatus.textContent = statusRes.installed
      ? (statusRes.running ? 'Watcher: running' : 'Watcher: installed, starting\u2026')
      : 'Watcher: not installed yet (installs automatically with your first folder)'
  } else {
    r.syncWatcherStatus.textContent = ''
  }

  if (!listRes || !listRes.ok) {
    r.syncFolderList.innerHTML = ''
    r.syncFoldersError.textContent = 'Could not load synced folders: ' + ((listRes && listRes.error) || 'unknown error')
    return
  }

  const roots = listRes.data || []
  if (!roots.length) {
    r.syncFolderList.innerHTML = '<p class="status-text">No synced folders yet.</p>'
    return
  }

  r.syncFolderList.innerHTML = ''
  for (const root of roots) {
    const row = document.createElement('div')
    row.className = 'file-row sync-folder-row'
    row.innerHTML =
      '<div class="file-icon">\u{1F4C1}</div>' +
      '<div class="file-info">' +
        '<span class="file-name">' + esc(root.local_path) + '</span>' +
        '<span class="file-meta">' + esc(root.remote_prefix) + '/ &middot; last sync: ' +
          esc(root.last_sync && !root.last_sync.startsWith('0001') ? fmtDateTime(root.last_sync) : 'never') +
        '</span>' +
      '</div>'
    const openBtn = document.createElement('button')
    openBtn.className = 'btn btn-ghost'
    openBtn.textContent = 'Open'
    openBtn.addEventListener('click', (e) => { e.stopPropagation(); window.tesseraDesktop.openPath(root.local_path) })
    const removeBtn = document.createElement('button')
    removeBtn.className = 'btn btn-danger'
    removeBtn.textContent = 'Remove'
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); onRemoveSyncFolder(root.id) })
    row.appendChild(openBtn)
    row.appendChild(removeBtn)
    r.syncFolderList.appendChild(row)
  }
}

async function onOpenSyncFolders() {
  r.syncFoldersModal.classList.remove('hidden')
  await renderSyncFolders()
}

async function onAddSyncFolder() {
  r.syncFoldersError.textContent = ''
  const localPath = await window.tesseraDesktop.pickFolder()
  if (!localPath) return  // cancelled

  r.btnAddSyncFolder.disabled = true
  try {
    const prefix = defaultSyncPrefix(localPath)
    const res = await window.tesseraDesktop.syncAdd(localPath, prefix)
    if (!res.ok) {
      r.syncFoldersError.textContent = 'Could not add that folder: ' + (res.error || res.stderr || 'unknown error')
      return
    }
    showToast('Folder synced: ' + localPath)
  } finally {
    r.btnAddSyncFolder.disabled = false
    await renderSyncFolders()
  }
}

async function onRemoveSyncFolder(rootId) {
  if (!confirm('Stop syncing this folder? Local files and remote copies are both kept.')) return
  const res = await window.tesseraDesktop.syncRemove(rootId)
  if (!res.ok) {
    r.syncFoldersError.textContent = 'Could not remove: ' + (res.error || res.stderr || 'unknown error')
  }
  await renderSyncFolders()
}

// ── lock / remove from this browser ──────────────────────
//
// Lock = drop sdk from memory, keep wrapped vault, next visit Unlock.
// Remove from this browser = delete tesseraweb.*, next visit Welcome.
// Two DIFFERENT buttons/actions, per law -- not a single confirm-toggle.

function onLock() {
  // DESKTOP PARITY (2026-09-29): disconnect the native bridge too, same
  // as Drop/ui.js's onLogout() -- otherwise the main process keeps an
  // authenticated native SDK instance alive after the UI has locked.
  if (isDesktop()) {
    window.tesseraDesktop.siaDisconnect().catch(() => {})
  }
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
