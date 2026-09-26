// @tessera/shared — file operations
//
// Desktop: delegates to native NAPI SDK via IPC.
// Web: uses proxy relay endpoints (POST /__sia__/upload etc.)
//      because WebTransport can't reach siamux hosts from the browser.
//
// PREFIX (2026-09-14, "tessera-web-v1"): relayCreds()/relayConnect() read
// the app-id/app-key localStorage pair through an injectable prefix so a
// second app (Tessera Web, 'tesseraweb') can call these same functions
// without ever reading Drop's tessera.aid/tessera.akey. Set once via
// setCredsPrefix() at app startup; defaults to 'tessera' (Drop, unchanged).

import { PinnedObject, encodedSize } from './sdk.js'
import { proxyOrigin } from './utils.js'
import { checkTunnelReachable } from './interceptor.js'

// SECTOR_SIZE (2026-09-17, "tessera-web-progress-denom"): fixed by the RHP4
// protocol itself (sia_core::rhp4::SECTOR_SIZE), not something either the
// SDK or Tessera controls -- matches the handoff doc's own citation. No
// exported constant for this exists in sia_storage_wasm.d.ts (checked), so
// it's hardcoded here exactly like the rest of this codebase already does
// (see UPLOAD_MAX_BUFFERED_SLABS's own comment above for the same 4 MiB
// figure used in its byte-budget math).
const SECTOR_SIZE = 4 * 1024 * 1024

// DEBUG DIARY (2026-09-24, "tessera-web-debug-log"): "Instrumented diary is
// on only when the page URL has query debug=1." Read LIVE from
// window.location at every call, never cached at Add start and never
// persisted to localStorage/cookie -- the URL itself is the switch, so a
// hard refresh without the query (or the operator stripping it) goes mute
// on the very next line this module would have written. isDebugOn() is the
// single reader web-ui.js's pane-visibility code also imports, so the two
// halves of the switch (what gets written here, what gets shown there)
// can never drift out of sync with each other.
export function isDebugOn() {
  try { return new URLSearchParams(window.location.search).get('debug') === '1' } catch (e) { return false }
}

// _diaryLines: pane-safe (8-hex only). _diaryLinesFull: same lines with any
// full host key restored, Copy-only -- "Full ed25519:... keys may exist
// inside the copied text, not as visible row chrome." Neither array is
// ever populated when isDebugOn() is false (checked at every push site
// below), so the mute case costs nothing beyond that one boolean read --
// "no extra diary lines beyond what fail-code + live-quiet already print
// to console."
let _diaryLines = []
let _diaryLinesFull = []
const DIARY_CAP = 200

// diaryReset(): "Start a fresh diary when an Add starts. Keep it until the
// next Add starts (Copy after fail must still work)." -- called once per
// Add, at the very top of the WASM upload path below, before anything else
// this Add will ever log. bundle= is read from the actual loaded <script>
// tag (the real deployed asset name), never hardcoded, so it can never go
// stale against a future rebuild.
function diaryReset() {
  if (!isDebugOn()) return
  const bundleSrc = (typeof document !== 'undefined' &&
    document.querySelector('script[type="module"][src*="main-"]')) || null
  // HEADER v=2 (2026-09-26, "tessera-web-debug-dl"): same fields as v=1
  // (utc, url, bundle, debug=1) -- only the version token changed, so
  // every pre-existing Add line pushed before a later Download in the
  // same Copy stays valid/readable under this header, per the packet's
  // own "old Add lines stay valid under it" instruction.
  const header = 'tessera-web-debug v=2 utc=' + new Date().toISOString() +
    ' url=' + window.location.href +
    ' bundle=' + (bundleSrc ? bundleSrc.getAttribute('src') : '-') +
    ' debug=1'
  _diaryLines = [header]
  _diaryLinesFull = [header]
  window.__tesseraDebugDiary = _diaryLines
  window.__tesseraDebugDiaryFull = _diaryLinesFull
  if (typeof window.__tesseraDebugPaneRepaint === 'function') window.__tesseraDebugPaneRepaint()
}

// diaryPush(line, fullLine): one timestamped line. fullLine defaults to
// line when there is no 8-hex/full-key split to make. No-op the entire
// time debug=1 is not present on the URL.
export function diaryPush(line, fullLine) {
  if (!isDebugOn()) return
  const stamped = 't=' + Date.now() + ' ' + line
  const stampedFull = 't=' + Date.now() + ' ' + (fullLine != null ? fullLine : line)
  _diaryLines.push(stamped)
  _diaryLinesFull.push(stampedFull)
  if (_diaryLines.length > DIARY_CAP) _diaryLines.shift()
  if (_diaryLinesFull.length > DIARY_CAP) _diaryLinesFull.shift()
  window.__tesseraDebugDiary = _diaryLines
  window.__tesseraDebugDiaryFull = _diaryLinesFull
  if (typeof window.__tesseraDebugPaneRepaint === 'function') window.__tesseraDebugPaneRepaint()
}

// hex8(): 8-hex row-chrome form of a host key, per the packet's own "Debug
// face: 8-hex only" law. Never throws on a short/odd key.
export function hex8(key) {
  if (!key) return '-'
  return String(key).replace(/^ed25519:/, '').slice(0, 8)
}

// PROGRESS DENOMINATOR (2026-09-17, "tessera-web-progress-denom"): "55/30 on
// a 250 MiB file. 30 is one slab, not the object." 10 data + 20 parity = 30
// shards per SLAB, not per file -- a slab's data side is
// dataShards * SECTOR_SIZE = 40 MiB of user bytes, so any file over ~40 MiB
// spans multiple slabs and the true total shard count is a multiple of 30,
// not a hardcoded 30. Computed once at Add time, before sdk.upload() is
// called, so the very first onShardUploaded tick already shows the right M.
//
// Path 1 (preferred): the SDK's own exported encodedSize(size, dataShards,
// parityShards) -- confirmed present in sia_storage_wasm.d.ts's export
// table, confirmed via source in sia-sdk-rs/sia_storage/src/lib.rs's
// encoded_size(): `slabs = ceil(size / (dataShards * SECTOR_SIZE)); return
// slabs * (dataShards + parityShards) * SECTOR_SIZE` -- i.e. it already
// returns total ON-NETWORK bytes across every shard of every slab for the
// whole object, exactly what this needs. Dividing by SECTOR_SIZE recovers
// the shard COUNT (M), cleanly by construction since the SDK's own formula
// is `slabs * totalShards * SECTOR_SIZE` -- always an exact multiple.
//
// Path 2 (fallback, if encodedSize ever throws/is unavailable): the same
// formula reimplemented directly, cited inline below.
function computeExpectedShards(fileSize, dataShards, parityShards) {
  if (fileSize == null || fileSize < 0) return null
  try {
    // NOTE: the browser/WASM build's encodedSize(data_size, data_shards,
    // parity_shards) takes a plain JS number (confirmed in
    // sia_storage_wasm.d.ts: `data_size: number`) -- NOT a bigint. Only the
    // separate Node native (napi) binding's encodedSize takes a bigint (see
    // index.node.d.ts) -- this app is browser-only, so plain number is
    // correct here. File sizes exceeding Number.MAX_SAFE_INTEGER (~9 PiB)
    // are already outside anything this app or the SDK's own WASM number
    // handling supports, so no precision concern in practice.
    const bytes = encodedSize(fileSize, dataShards, parityShards)
    const m = Number(bytes) / SECTOR_SIZE
    if (Number.isFinite(m) && m > 0 && Number.isInteger(m)) return m
    // Non-integer would mean encodedSize's own formula stopped being an
    // exact multiple of SECTOR_SIZE -- fall through to path 2 rather than
    // print a lying non-integer denominator.
  } catch (e) {
    console.warn('[tessera-web] encodedSize() unavailable, using manual slab formula:', e && e.message)
  }
  // Path 2: slabs = ceil(size / (dataShards * SECTOR_SIZE)); M = slabs * 30.
  // The LAST slab of a file still ships a full dataShards+parityShards set
  // (erasure coding pads the final slab, it doesn't ship a partial one) --
  // same formula sia-sdk-rs's own encoded_size() uses, reimplemented here
  // only as a fallback if the SDK export itself is ever unavailable.
  const totalShards = dataShards + parityShards
  const slabDataBytes = dataShards * SECTOR_SIZE
  const slabs = Math.ceil(fileSize / slabDataBytes)
  return slabs > 0 ? slabs * totalShards : null
}

// CONCURRENCY TUNABLES (2026-09-16, "tessera-web-inflight-v2" — REVISES
// "tessera-web-inflight" 2026-09-14, whose own maxInflight fix never
// actually worked; see that packet's own recon report for the full
// trace). One-line-to-revert switches, deliberately kept as their own
// named exported constants at the top of the file (same convention as
// MAP_SHARDS_CAP below) rather than inlined at each call site, so a
// bad real-world result can be undone by changing ONE number back, or
// by setting either to `null` to fully restore stock SDK behavior
// (both options are genuinely optional -- see UploadOptions/
// DownloadOptions in sia_storage_wasm.d.ts -- so `null` here always
// means "don't pass this key at all", never "pass zero").
//
// UPLOAD_MAX_BUFFERED_SLABS: replaces the dead `maxInflight: 10` (that
// option was removed from the SDK before our installed version --
// silently ignored, never had any effect). This is the REAL, still-
// live knob: it raises the ceiling the SDK's own adaptive inflight
// controller (congestion.rs, stock, untouched by us) is allowed to
// climb toward -- we are NOT hardcoding a fixed concurrency number,
// only raising the ceiling that existing adaptive logic already
// climbs toward on its own. Cap in shard-slots = value * 30 (Tessera's
// fixed 10+20 shard layout); cap in bytes = value * 120 MiB (30 shards
// * 4 MiB SECTOR_SIZE per shard). 4 -> 480 MiB peak buffer, comfortably
// above the controller's own doubling path (8 -> 16 -> 32 -> 64 ->
// clamped at 120) without over-committing a browser tab's memory.
// Stock WASM default (used when this is `null`) is a hardcoded `2`
// (60 slots / 240 MiB) -- see sia_storage/src/upload.rs's own
// #[cfg(target_arch = "wasm32")] default_slabs_in_memory().
export const UPLOAD_MAX_BUFFERED_SLABS = 4   // null = stock WASM default (2)

// DOWNLOAD_MAX_BUFFERED_CHUNKS: the operator's own stated intent was
// "concurrency on downloads was intended to be 10" -- stock WASM
// default is already 32 (see sia_storage/src/download.rs's own
// default_chunks_in_memory(), #[cfg(target_arch = "wasm32")] branch),
// which already comfortably exceeds 10, so nothing was ever actually
// capping downloads below the intended value. Set explicitly anyway
// (matching, not raising, the current default) purely so the intent
// is self-documented in OUR code instead of relying silently on a
// value we don't control living upstream.
export const DOWNLOAD_MAX_BUFFERED_CHUNKS = 32   // null = stock WASM default (32) -- explicit here only to document intent, not to change behavior

// TAIL-ZONE PREDICATE (2026-09-23, "tessera-web-fail-code"): named
// export of the exact "near the end" condition uploadFile()'s own
// stallBudgetMs() uses to pick between STALL_MS and TAIL_STALL_MS
// (>= expectedShards - 2, covers 28/30 and 29/30 per the 2026-09-20
// "tessera-web-29-of-30" packet). web-ui.js's fail-code classifier
// imports this SAME function to label a stall T20M (mid-slab) vs T0T
// (tail) -- reading the one threshold the timer already applies,
// never a second, independently-derived tail rule.
export function isTailZone(shardsLanded, expectedShards) {
  return shardsLanded >= expectedShards - 2
}

// FOLDERS (2026-09-15, "tessera-web-folders-v1", REVISED 2026-09-15
// "tessera-web-folder-create-fail"): "The SDK has no directories. A
// folder is a prefix on the object's existing metadata name." Forward
// slashes only; display name is the last segment; root is "".
//
// REVISION -- empty folders are now VIRTUAL, not a pinned marker
// object. The original design (marker mime, below, now UNUSED for
// creation but kept exported/documented since a marker object from
// before this fix may still exist in some account's real object list
// and must still be recognized/hidden if seen) pinned a zero-byte
// object per empty folder. That zero-byte upload throws inside the
// WASM SDK's own erasure-coding step -- confirmed via the WASM
// binary's own error strings ("data shards cannot be zero", "empty
// shard", "TooFewShards") and via encodedSize(0, 10, 20) === 0n (a
// zero-byte object produces ZERO encoded shards, which cannot satisfy
// a 10-data-shard request no matter what dataShards/parityShards are
// passed) -- there is no tiny-but-nonzero blob that fixes this; ANY
// empty object is fundamentally incompatible with erasure coding.
// This is why every New Folder click failed with the same toast on
// every retry (files.js createFolderMarker -> sdk.upload() rejecting
// before any network/host activity, confirmed by the fact this
// packet's own catch block below now logs the REAL thrown message).
//
// FIX: an empty folder is now purely a client-side fact -- its path
// is recorded in this browser's own localStorage
// (PREFIX + '.folders', a JSON array of path strings), never pinned,
// never costing a real 10+20 write. "First real Add inside the
// folder still writes Photos/vacation.jpg in object metadata" is
// unchanged -- a folder that already has a real file inside it needs
// no localStorage row at all (computeFolderView infers it from the
// file's own prefix, same as before). Reload still shows an empty
// folder correctly IF it was created in this same browser (its path
// is still in localStorage) -- "That is acceptable" per the packet's
// own law; it does not survive a different browser/device, which a
// pinned marker would have (at the cost of every New Folder click
// failing outright, which is strictly worse).
export const FOLDER_MARKER_MIME = 'application/x-tessera-folder'

const VIRTUAL_FOLDERS_KEY_SUFFIX = '.folders'

function virtualFoldersKey() {
  return _credsPrefix + VIRTUAL_FOLDERS_KEY_SUFFIX
}

// getVirtualFolders(): the full list of empty-folder paths this
// browser has created, from localStorage. Corrupt/missing JSON reads
// back as an empty list rather than throwing -- a broken localStorage
// value must never crash the Files screen.
export function getVirtualFolders() {
  try {
    const raw = localStorage.getItem(virtualFoldersKey())
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter(p => typeof p === 'string') : []
  } catch (_) {
    return []
  }
}

function setVirtualFolders(paths) {
  localStorage.setItem(virtualFoldersKey(), JSON.stringify(paths))
}

// addVirtualFolder(path): records a new empty folder path. No SDK
// call, no network, no upload, no pin -- this is the entire "create"
// operation for an empty folder now. Idempotent (a path already
// present is not duplicated).
export function addVirtualFolder(path) {
  const paths = getVirtualFolders()
  if (!paths.includes(path)) {
    paths.push(path)
    setVirtualFolders(paths)
  }
}

// removeVirtualFolder(path): "Delete empty folder removes that path
// from tesseraweb.folders only." No SDK call -- there is no marker
// object to delete anymore.
export function removeVirtualFolder(path) {
  const paths = getVirtualFolders().filter(p => p !== path)
  setVirtualFolders(paths)
}

// renameVirtualFolderPrefix(oldPath, newPath): (Apple B, 2026-09-16)
// "Update tesseraweb.folders virtual rows the same way (old path and
// any old/... children)." Rewrites every virtual-folder row whose
// path is exactly oldPath OR nested under it (oldPath + '/...') to
// the equivalent path under newPath -- same prefix-swap rule
// renameFilePath() uses for real objects, kept here (not imported
// from below, to avoid a forward reference) since virtual folders
// have no `mime`/object shape to share logic with real files. No SDK
// call -- purely a localStorage rewrite, same as every other virtual-
// folder operation in this file.
export function renameVirtualFolderPrefix(oldPath, newPath) {
  const paths = getVirtualFolders()
  const oldPrefix = oldPath + '/'
  const rewritten = paths.map(p => {
    if (p === oldPath) return newPath
    if (p.startsWith(oldPrefix)) return newPath + p.slice(oldPath.length)
    return p
  })
  setVirtualFolders(rewritten)
}

// removeVirtualFolderPrefix(path): (Apple B, 2026-09-16) "drop the
// virtual path and child virtual paths" -- used by folder delete, as
// opposed to removeVirtualFolder() above which only ever drops the
// EXACT path (used by the old empty-folder-only delete). Delete must
// also clear any virtual (still-empty) subfolder that lived under the
// deleted folder, or those rows would silently orphan in
// tesseraweb.folders forever with no way to reach them again (their
// parent is gone).
export function removeVirtualFolderPrefix(path) {
  const prefix = path + '/'
  const paths = getVirtualFolders().filter(p => p !== path && !p.startsWith(prefix))
  setVirtualFolders(paths)
}

export function buildPath(dir, basename) {
  return dir ? dir + '/' + basename : basename
}

// ── map shard persistence (2026-09-16, "tessera-web-add-hang-map400") ──
//
// "The map must show where this silo's shards already are, not only
// arcs during the live Add." Every landed shard that has lat/long
// becomes a stored pinpoint record, persisted under this browser's
// creds-prefix key (same pattern as VIRTUAL_FOLDERS_KEY_SUFFIX above --
// tesseraweb.mapshards for Web, tessera.mapshards for Drop, never
// cross-read). JSON array, oldest dropped first, hard-capped at
// MAP_SHARDS_CAP records -- NOT 400 hosts, 400 shard records (the same
// host can appear in many records, one per shard that landed there).
const MAP_SHARDS_KEY_SUFFIX = '.mapshards'
export const MAP_SHARDS_CAP = 250   // 2026-09-16 "tessera-web-handoff adjustments": was 400

function mapShardsKey() {
  return _credsPrefix + MAP_SHARDS_KEY_SUFFIX
}

// getMapShards(): the full list of {hostKey, lat, lon, dir, at} shard
// records this browser has recorded landing, oldest first. Corrupt/
// missing JSON reads back as an empty list -- a broken localStorage
// value must never crash the Files/map screen.
export function getMapShards() {
  try {
    const raw = localStorage.getItem(mapShardsKey())
    const arr = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    return arr.filter(r => r && typeof r.lat === 'number' && typeof r.lon === 'number')
  } catch (_) {
    return []
  }
}

// addMapShard(record): appends one landed-shard record and trims to
// MAP_SHARDS_CAP, oldest dropped first ("Cap 400 shards... Browser
// cache must not grow without bound"). Records with no lat/lon are
// never stored -- "Skip records with no lat/long. Do not call hosts()
// to fill geo" -- callers are expected to have already run the
// hostKey through map.js's own geoLookup()/normalizeHostKey() and only
// call this when a real {lat, lon} was found; this function itself
// makes no network call and does no geo lookup, it only persists what
// it's given.
export function addMapShard(record) {
  if (!record || typeof record.lat !== 'number' || typeof record.lon !== 'number') return
  const shards = getMapShards()
  shards.push({
    hostKey: record.hostKey || null,
    lat: record.lat,
    lon: record.lon,
    dir: record.dir || 'upload',
    at: record.at || Date.now(),
  })
  // TRIM (cite): oldest dropped first, hard cap -- this is the only
  // place the stored array can grow, and it never exceeds MAP_SHARDS_CAP
  // entries after this line runs.
  const trimmed = shards.length > MAP_SHARDS_CAP ? shards.slice(shards.length - MAP_SHARDS_CAP) : shards
  localStorage.setItem(mapShardsKey(), JSON.stringify(trimmed))
}

// MAP SHOW/HIDE PREFERENCE (2026-09-16, "tessera-web-handoff
// adjustments"): "User's map show/hide preference should persist. On
// first visit, initial state is hidden. Upon a user's first upload
// only, map should be unhidden. From then on, user's map preference
// persists." Persisted the same way folders/mapshards already are --
// one localStorage key under this browser's creds-prefix, tri-state
// via presence: absent (never explicitly set = "first visit, no
// upload yet") vs the literal strings 'shown'/'hidden' once the user
// (or the one-time auto-unhide-on-first-upload rule) has set it.
// getMapShownPref() returning null (not a boolean) is the signal
// "no explicit preference yet" -- callers must NOT treat null as
// false, or the first-visit/first-upload distinction collapses.
const MAP_SHOWN_KEY_SUFFIX = '.mapshown'

function mapShownKey() {
  return _credsPrefix + MAP_SHOWN_KEY_SUFFIX
}

export function getMapShownPref() {
  const raw = localStorage.getItem(mapShownKey())
  if (raw === 'shown') return true
  if (raw === 'hidden') return false
  return null  // no explicit preference yet (first visit, pre-first-upload)
}

export function setMapShownPref(shown) {
  localStorage.setItem(mapShownKey(), shown ? 'shown' : 'hidden')
}

// folderMarkerName(path): the metadata `name` a LEGACY folder marker
// object (pinned by the original folders-v1 design, before this fix)
// would have used -- always path + '/'. Still exported/used by
// computeFolderView()/isNonEmptyFolder() below so that if any account
// already has a real marker object from before this fix, it is still
// correctly recognized and hidden, not shown as a garbled file row.
// No code path PINS a new one anymore -- see the block comment above.
export function folderMarkerName(path) {
  return path + '/'
}

// validateFolderName(raw): "Reject empty, /, ., .. . Trim. Max 64
// characters." Applied to a SINGLE new segment (what "New folder"
// prompts for) -- a slash anywhere in the typed name is rejected
// outright, not just the exact strings "/" -- New folder always
// creates ONE segment inside the current directory; nesting happens by
// navigating in and creating another folder, not by typing a path.
export function validateFolderName(raw) {
  const name = (raw || '').trim()
  if (!name) return { ok: false, error: 'Please enter a folder name.' }
  if (name === '.' || name === '..') return { ok: false, error: 'That name is not allowed.' }
  if (name.includes('/')) return { ok: false, error: 'Folder names cannot contain "/".' }
  if (name.length > 64) return { ok: false, error: 'Folder names are limited to 64 characters.' }
  return { ok: true, name }
}

// computeFolderView(files, currentPath, virtualFolders): splits the
// SDK's flat object list into the folders and files visible AT this
// one directory level -- "folder rows sit above file rows in the
// current place." `files` is listFiles()'s own flat array (every
// object, full-path `name`, unfiltered). `currentPath` is '' at root
// or a full path with no trailing slash (e.g. "Photos/Italy").
//
// NEW 3rd argument `virtualFolders` (2026-09-15,
// "tessera-web-folder-create-fail"): the localStorage-backed empty-
// folder path list from getVirtualFolders(). A folder now appears in
// the view for EITHER reason: a real file exists somewhere below it
// (inferred from object names, unchanged from before), OR its exact
// path is in this list (new). Optional/defaults to [] so any other
// caller that doesn't pass it still behaves exactly as before this
// fix for folders that already have real content.
export function computeFolderView(files, currentPath, virtualFolders) {
  virtualFolders = virtualFolders || []
  const prefix = currentPath ? currentPath + '/' : ''
  const folderNames = new Set()
  const fileRows = []
  for (const f of files) {
    if (prefix && !f.name.startsWith(prefix)) continue
    if (!prefix && f.name.includes('/') === false) {
      // Root, no prefix to strip -- a root-level file with no slash at
      // all in its name. Falls through to the fileRows push below.
    }
    const rel = prefix ? f.name.slice(prefix.length) : f.name
    if (rel === '') continue  // this directory's OWN marker (legacy) -- never a row
    const slashIdx = rel.indexOf('/')
    if (slashIdx === -1) {
      // A direct child with no further path segment. A LEGACY marker
      // object (mime === FOLDER_MARKER_MIME) can only ever produce
      // rel === '' (handled above), so anything reaching here with no
      // slash is a genuine file -- but guard defensively anyway in
      // case of a malformed/legacy object.
      if (f.mime === FOLDER_MARKER_MIME) continue
      fileRows.push({ ...f, displayName: rel })
    } else {
      // Something inside a subfolder named rel.slice(0, slashIdx).
      folderNames.add(rel.slice(0, slashIdx))
    }
  }
  // Merge in virtual (empty, localStorage-only) folders that live
  // directly under currentPath -- same one-level-deep rule as the
  // real-object inference above.
  for (const vPath of virtualFolders) {
    if (prefix && !vPath.startsWith(prefix)) continue
    if (!prefix && vPath.includes('/')) continue  // not a direct child of root
    const rel = prefix ? vPath.slice(prefix.length) : vPath
    if (!rel || rel.includes('/')) continue  // not a direct child of currentPath
    folderNames.add(rel)
  }
  const folders = Array.from(folderNames).sort().map(name => ({
    name,
    path: buildPath(currentPath, name),
  }))
  return { folders, files: fileRows }
}

// isNonEmptyFolder(files, path): "Delete on a folder that has files:
// refuse... Do not recurse [into deleting]." This check itself DOES
// recurse (read-only) into every depth below `path` -- a file two
// levels down still means "this folder has files," matching the
// proof's own framing ("Delete Photos while it still has a file is
// refused" -- the file could be directly in Photos or in Photos/Italy).
// LEGACY marker objects (mime === FOLDER_MARKER_MIME) do not count as
// "files" here -- an entirely-empty nested subfolder (marker only, no
// real content anywhere under it) does not by itself make an ancestor
// folder "have files". Virtual (localStorage) folders never appear in
// `files` at all, so they naturally never count as "having files"
// either -- no special-casing needed for them here.
export function isNonEmptyFolder(files, path) {
  const prefix = path + '/'
  return files.some(f => f.name.startsWith(prefix) && f.mime !== FOLDER_MARKER_MIME)
}

// findFolderMarkerId(files, path): the LEGACY marker object's own id,
// if one exists (pinned by the original folders-v1 design before this
// fix). Exact match only -- path + '/' -- never a prefix match. A
// folder created after this fix has no marker at all -- this returns
// null for those, which the caller (onDeleteFolder in web-ui.js)
// handles by falling through to the virtual-folder removal path
// instead.
export function findFolderMarkerId(files, path) {
  const markerName = folderMarkerName(path)
  const hit = files.find(f => f.name === markerName)
  return hit ? hit.id : null
}

// ── folder rename / delete (Apple B, 2026-09-16) ──────────
//
// "Apple: a folder is a place. Renaming it renames the place. Deleting
// it deletes what is inside, after a confirm that names the damage."
// This REPLACES the old "refuse if non-empty" delete behavior below
// (onDeleteFolder in web-ui.js is rewritten to call these) -- the old
// "This folder has files." refuse string is gone entirely, not
// branched around.

// filesUnderFolder(files, path): every REAL object (never a legacy
// marker) whose path is path itself or nested under it --
// path + '/...' at any depth. Used by BOTH rename (rewrite each) and
// delete (delete each) so "N" in the delete confirm and the actual
// set of objects touched are always the exact same list -- never
// computed twice with different logic.
export function filesUnderFolder(files, path) {
  const prefix = path + '/'
  return files.filter(f => f.mime !== FOLDER_MARKER_MIME &&
    (f.name === path || f.name.startsWith(prefix)))
}

// countFilesUnderFolder(files, path): "N is the count of real objects
// under that path, including nested." A thin wrapper so the confirm
// dialog's own count and the delete loop's own list are provably the
// same query, not two hand-synced numbers.
export function countFilesUnderFolder(files, path) {
  return filesUnderFolder(files, path).length
}

// renameFilePath(oldFullPath, oldPrefix, newPrefix): rewrites a single
// file's own full path from under oldPrefix to under newPrefix --
// "Photos/Italy/a.jpg" with oldPrefix "Photos", newPrefix "Travel"
// becomes "Travel/Italy/a.jpg" (nested stays nested: only the leading
// segment matching oldPrefix is swapped, everything after it is
// preserved verbatim). oldFullPath === oldPrefix (the folder's own
// exact path, only possible for a LEGACY marker object) maps directly
// to newPrefix with no trailing content.
export function renameFilePath(oldFullPath, oldPrefix, newPrefix) {
  if (oldFullPath === oldPrefix) return newPrefix
  return newPrefix + oldFullPath.slice(oldPrefix.length)
}

// validateFolderRenameName(raw, siblingFolderNames): folders reuse
// validateFolderName's char rules (empty/slash/./../64-char) but ALSO
// refuse a sibling folder collision -- "Collision with a sibling
// folder: refuse with one sentence. Do not invent 'Photos (1)' for
// folders this packet." siblingFolderNames is the set of OTHER
// folder names at the same level (the renaming folder's own old name
// is expected to already be excluded by the caller, same
// excludeId-style convention as existingBasenamesInFolder).
export function validateFolderRenameName(raw, siblingFolderNames) {
  const result = validateFolderName(raw)
  if (!result.ok) return result
  if ((siblingFolderNames || []).includes(result.name)) {
    return { ok: false, error: 'A folder named "' + result.name + '" already exists here.' }
  }
  return result
}

// computeAllFolderPaths(files, virtualFolders): every folder path that
// exists at ANY depth -- used by Move's destination picker ("pick Root
// or a folder that already exists (virtual or inferred)"), unlike
// computeFolderView() which only returns the ONE level directly under
// currentPath. Ancestors are always included even if only a deeper
// descendant path was ever recorded (e.g. a file at "Photos/Italy/x.jpg"
// implies both "Photos" and "Photos/Italy" exist as destinations).
export function computeAllFolderPaths(files, virtualFolders) {
  const set = new Set()
  const addAncestors = (path) => {
    const segs = path.split('/')
    let acc = ''
    for (let i = 0; i < segs.length; i++) {
      acc = acc ? acc + '/' + segs[i] : segs[i]
      set.add(acc)
    }
  }
  for (const f of files) {
    if (f.mime === FOLDER_MARKER_MIME) continue
    const idx = f.name.lastIndexOf('/')
    if (idx === -1) continue  // root-level file, no folder implied
    addAncestors(f.name.slice(0, idx))
  }
  for (const vPath of (virtualFolders || [])) {
    if (vPath) addAncestors(vPath)
  }
  return Array.from(set).sort()
}

// existingBasenamesInFolder(files, destPath, excludeId): the basenames
// of every real file that is a DIRECT child of destPath ('' = root) --
// the sibling set a new/moved/renamed name must not collide with.
// excludeId lets Move/Rename check against every sibling EXCEPT the
// file being acted on itself (its own current name must never count as
// a collision against itself).
export function existingBasenamesInFolder(files, destPath, excludeId) {
  const prefix = destPath ? destPath + '/' : ''
  const names = []
  for (const f of files) {
    if (excludeId && f.id === excludeId) continue
    if (f.mime === FOLDER_MARKER_MIME) continue
    if (prefix && !f.name.startsWith(prefix)) continue
    const rel = prefix ? f.name.slice(prefix.length) : f.name
    if (!rel || rel.includes('/')) continue  // not a direct child of destPath
    names.push(rel)
  }
  return names
}

// resolveCollisionName(existingBasenames, basename): "Never overwrite.
// Never two visible names that match. vacation.jpg exists -> vacation
// (1).jpg. That exists -> vacation (2).jpg. Keep the extension. Space
// before the paren." Applies identically to Move, Add-into-folder, and
// Add at Root -- callers just pass the right sibling set.
export function resolveCollisionName(existingBasenames, basename) {
  if (!existingBasenames.includes(basename)) return basename
  const dotIdx = basename.lastIndexOf('.')
  const hasExt = dotIdx > 0  // dotIdx === 0 means a leading-dot name with no real extension (e.g. ".bashrc")
  const stem = hasExt ? basename.slice(0, dotIdx) : basename
  const ext = hasExt ? basename.slice(dotIdx) : ''
  let n = 1
  let candidate
  do {
    candidate = stem + ' (' + n + ')' + ext
    n++
  } while (existingBasenames.includes(candidate))
  return candidate
}

// validateRenameName(raw): lighter than validateFolderName() -- file
// basenames are not capped at 64 chars (folders are; files routinely
// carry long real-world names) and there is no "." / ".." special case
// beyond the same slash ban (a file can legitimately be named
// "v2.1.tar.gz" etc., so dots themselves are fine).
export function validateRenameName(raw) {
  const name = (raw || '').trim()
  if (!name) return { ok: false, error: 'Please enter a name.' }
  if (name.includes('/')) return { ok: false, error: 'Names cannot contain "/".' }
  return { ok: true, name }
}

// renameObjectPath(sdk, objectId, newFullName): "Move is metadata only
// (updateMetadata + updateObjectMetadata). No second 10+20. No
// sdk.upload." Fetches the PinnedObject handle for objectId, rewrites
// ONLY its metadata.name (mime is read back off the existing metadata
// and preserved untouched), then pushes the new metadata to the
// indexer. No upload(), no hosts() -- this function makes exactly the
// two calls the law names, nothing else. Used by both Move (destPath
// changes) and Rename (basename changes, same folder) -- the caller
// computes the full new path/name; this function just writes it.
export async function renameObjectPath(sdk, objectId, newFullName) {
  const obj = await sdk.object(objectId)
  const metaBytes = obj.metadata()
  let mime = 'application/octet-stream'
  try {
    const m = JSON.parse(new TextDecoder().decode(metaBytes))
    if (m.mime) mime = m.mime
  } catch (_) {}
  const newMeta = new TextEncoder().encode(JSON.stringify({ name: newFullName, mime }))
  obj.updateMetadata(newMeta)
  await sdk.updateObjectMetadata(obj)
  return obj
}

// ── helpers ──────────────────────────────────────────────

function isDesktop() {
  return !!(window.tesseraDesktop && window.tesseraDesktop.isDesktop)
}

let _credsPrefix = 'tessera'
export function setCredsPrefix(prefix) { _credsPrefix = prefix }

function relayUrl(path) {
  return proxyOrigin() + '/__sia__/' + path
}

function relayCreds() {
  const appId = localStorage.getItem(_credsPrefix + '.aid') || ''
  const appKey = localStorage.getItem(_credsPrefix + '.akey') || ''
  if (!appId || !appKey) return ''
  return 'appId=' + encodeURIComponent(appId) + '&appKey=' + encodeURIComponent(appKey)
}

async function relayFetch(method, path, body) {
  const creds = relayCreds()
  // FIX (2026-09-14, discovered while building Tessera Web): this used to
  // throw a message containing the substring "Not connected", which every
  // call site below re-throws instead of falling back to the WASM SDK
  // (see the catch blocks). That collided with the ALWAYS-EXPECTED case
  // of no plaintext appKey being saved at all -- which is now the NORMAL
  // state for any latched Drop account (tessera-drop-local-latch removed
  // plaintext tessera.akey once a vault exists) and for any account using
  // a non-'tessera' creds prefix (Tessera Web). Both cases must fall
  // through to WASM every time, not re-throw. Renamed so it no longer
  // matches the 'Not connected' guard; a genuine relay-reported
  // not-connected error (from the JSON response body, not this check)
  // still uses that exact phrase and is unaffected.
  if (!creds) throw new Error('No relay credentials saved for this prefix')

  const url = relayUrl(path) + (path.includes('?') ? '&' : '?') + creds
  const opts = { method }
  if (body) opts.body = body

  const resp = await fetch(url, opts)
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status }))
    throw new Error(err.error || 'HTTP ' + resp.status)
  }
  return resp
}

async function relayConnect() {
  const appId = localStorage.getItem(_credsPrefix + '.aid') || ''
  const appKey = localStorage.getItem(_credsPrefix + '.akey') || ''
  if (!appId || !appKey) return false

  const resp = await fetch(relayUrl('connect'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, appKey }),
  })
  const result = await resp.json()
  return result.ok
}

// ── list ────────────────────────────────────────────────

export async function listFiles(sdk) {
  if (isDesktop()) {
    const result = await window.tesseraDesktop.siaListFiles()
    if (!result.ok) throw new Error(result.error)
    return result.files
  }

  // Web: try proxy relay first
  try {
    const resp = await relayFetch('GET', 'list')
    const result = await resp.json()
    if (result.ok) return result.files
  } catch (_) { /* fall back to WASM SDK below */ }

  // Web fallback: WASM SDK
  const byId = new Map()
  let cursor = null
  for (;;) {
    const events = await sdk.objectEvents(cursor || undefined, 100)
    if (!events || !events.length) break
    for (const ev of events) {
      if (ev.deleted) { byId.delete(ev.id); continue }
      let name = ev.id.slice(0, 12) + '\u2026'
      let mime = ''
      let size = 0
      const obj = ev.object
      if (obj) {
        size = obj.size()
        const meta = obj.metadata()
        if (meta && meta.length) {
          try {
            const m = JSON.parse(new TextDecoder().decode(meta))
            if (m.name) name = m.name
            // FOLDERS (2026-09-15, "tessera-web-folders-v1"): mime is
            // read through untouched here -- computeFolderView()/
            // isNonEmptyFolder() need it to recognize a folder marker
            // object (FOLDER_MARKER_MIME) and exclude it from the file
            // rows / "has files" check. Existing callers that only
            // ever used f.name/f.size are unaffected by this extra
            // field on the returned object.
            if (m.mime) mime = m.mime
          } catch (_) {}
        }
      }
      byId.set(ev.id, { id: ev.id, name, mime, size, updatedAt: ev.updatedAt })
    }
    const last = events[events.length - 1]
    const next = { id: last.id, after: last.updatedAt }
    if (cursor && cursor.id === next.id) break
    cursor = next
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  )
}

export function computeTotals(files) {
  let total = 0
  for (const f of files) total += f.size
  return { count: files.length, totalBytes: total }
}

// ── upload ──────────────────────────────────────────────

// FOLDERS (2026-09-15, "tessera-web-folders-v1"): "Add while inside a
// folder writes currentPath + file.name into metadata, then the usual
// 10+20 + pin." New optional `metaName` parameter -- when provided,
// this exact string is what gets pinned into metadata.name (full path,
// e.g. "Photos/vacation.jpg"), while `file.name` (the browser File
// object's own leaf name, e.g. "vacation.jpg") is still what's sent to
// the relay's own `name=` query param and read for its MIME-sniffing
// extension -- the relay path is DEAD for Tessera Web regardless (no
// relay creds ever saved under the 'tesseraweb' prefix, confirmed by
// this file's own PREFIX comment), so `metaName` only actually takes
// effect on the WASM fallback below, which is the only path Web ever
// reaches. Every existing caller (Drop's ui.js, desktop) omits this
// argument entirely -- defaults to `file.name`, byte-identical to
// before this packet.
// SERIAL LOCK (2026-09-20, "tessera-web-add-overlap-stall"): "Cite the
// hole that let a second drop run." THE HOLE: web-ui.js's own
// _uploadActive/_uploadQueue flag is a QUEUE-LEVEL lock -- it flips
// false the instant doUpload() returns/throws, INCLUDING when a
// watchdog (stall or pin) wins its race and doUpload() throws while
// the underlying, abandoned sdk.upload()/sdk.pinObject() call is
// STILL RUNNING in the background (files.js's own uploadPromise.catch
// (() => {}) comment already documents this: "it may keep running in
// the background... this only prevents an unhandled-rejection console
// warning, it does not stop that background work"). The queue then
// starts the NEXT file's real sdk.upload() while the first one's real
// call is still live underneath -- two genuinely concurrent uploads,
// exactly what the operator saw (drop a second file while "pinning"
// was showing; bar zeroed; new arcs). The queue-level lock was never
// wrong about ITS OWN state; it just has no visibility into whether
// the REAL SDK call it thinks ended has actually ended.
//
// FIX: a lock at THIS level (files.js, where the real sdk.upload()/
// pinObject() calls actually live) that a second uploadFile() WASM-
// path call must wait on before calling sdk.upload() at all -- closes
// the hole regardless of what doUpload()'s own watchdog races do.
// Released only when the REAL underlying promise chain (upload +
// pin) actually settles, resolve or reject, never when a watchdog
// merely gives up waiting on it.
let _realUploadLock = Promise.resolve()
// Exported so web-ui.js's own queue/drop handlers can synchronously
// check "is a real upload chain actually still running right now" --
// distinct from _uploadActive (web-ui.js's own queue-level flag,
// which per the hole above can go false while this is still true).
export function isRealUploadInFlight() { return _realUploadInFlight }
let _realUploadInFlight = false
// Exported for processUploadQueue() to await BEFORE popping the next
// queued item off _uploadQueue -- so a genuinely queued file (already
// accepted, already toasted "Queued: ...") waits its turn on the real
// lock instead of reaching doUpload()'s own isRealUploadInFlight()
// guard and being rejected with "Already adding a file." (that
// rejection is for an UNQUEUED second drop arriving mid-upload, not
// for a file this app already promised to queue).
export function waitForUploadSlot() { return _realUploadLock.catch(() => {}) }

export async function uploadFile(sdk, file, onProgress, metaName) {
  if (isDesktop()) {
    const start = Date.now()
    const tick = (s, p) => { if (onProgress) onProgress({ stage: s, percent: p, elapsed: Date.now() - start }) }
    tick('reading', 0)
    const filePath = await window.tesseraDesktop.openFileDialog()
    if (!filePath) throw new Error('No file selected')
    const fileBuffer = await window.tesseraDesktop.readFile(filePath)
    const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'upload'
    tick('uploading', 10)
    const ext = (fileName.split('.').pop() || '').toLowerCase()
    const mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
      webp:'image/webp', svg:'image/svg+xml', pdf:'application/pdf', txt:'text/plain',
      md:'text/markdown', json:'application/json', js:'application/javascript',
      html:'text/html', css:'text/css', zip:'application/zip', mp4:'video/mp4',
      mp3:'audio/mpeg', wav:'audio/wav' }
    const mimeType = mimeMap[ext] || 'application/octet-stream'
    const result = await window.tesseraDesktop.siaUpload(fileName, fileBuffer, mimeType)
    if (!result.ok) throw new Error(result.error)
    tick('done', 100)
    return { id: result.id, size: result.size }
  }

  // Web: try proxy relay first
  //
  // FIX (2026-09-14, "tessera-web-add-relay"): this used to unconditionally
  // re-throw on ANY relay failure -- including the always-expected "No relay
  // credentials saved for this prefix" case (Tessera Web's 'tesseraweb'
  // prefix never has relay creds; tessera-proxy stays dead by law). Every
  // sibling op (listFiles/downloadToDisk/deleteFile/createShareURL) already
  // falls through to the WASM SDK on relay miss -- upload was the one path
  // that didn't, so "Add" was the only op that could surface an internal
  // string like "No relay credentials saved for this prefix" to the
  // customer. Now it falls through silently, same as the others.
  if (file) {
    const start = Date.now()
    const tick = (s, p) => { if (onProgress) onProgress({ stage: s, percent: p, elapsed: Date.now() - start }) }
    // BAR HOLD (2026-09-16, "tessera-web-encode-hold"): this relay path
    // is DEAD for Tessera Web (confirmed by this file's own PREFIX
    // comment at the top: no relay creds are ever saved under the
    // 'tesseraweb' prefix) -- but the unconditional `tick('uploading',
    // 10)` that used to run here fired BEFORE relayCreds() was even
    // checked, on every single Web Add, emitting a premature real
    // progress tick that immediately unhid the bar at 0%/10% before
    // any host was ever contacted. relayCreds() is synchronous/cheap
    // (plain localStorage reads, no network) -- checking it FIRST and
    // skipping this entire block (ticks included) when there is
    // nothing to relay to is what actually fixes "bar jumps straight
    // to uploading" for Web, not just the WASM path's own tick
    // removal below. Drop (which DOES have relay creds under its own
    // 'tessera' prefix) is completely unaffected: relayCreds() returns
    // non-empty there, so this block runs exactly as it always did.
    if (relayCreds()) {
    tick('uploading', 10)

    // Animate progress while the upload runs (the relay doesn't stream progress)
    let progress = 10
    const timer = setInterval(() => {
      if (progress < 85) { progress += 3; tick('uploading', progress) }
    }, 2000)

    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const resp = await relayFetch('POST', 'upload?name=' + encodeURIComponent(file.name) +
        '&mime=' + encodeURIComponent(file.type || 'application/octet-stream'), bytes)
      const result = await resp.json()
      clearInterval(timer)
      if (!result.ok) throw new Error(result.error)
      tick('pinning', 95)
      tick('done', 100)
      return { id: result.id, size: result.size }
    } catch (e) {
      clearInterval(timer)
      // Fall through to the WASM SDK below on any relay miss -- including
      // the always-expected "No relay credentials saved for this prefix"
      // case, matching listFiles/downloadToDisk/deleteFile/createShareURL's
      // fallback behavior. Only a genuine relay-reported "Not connected"
      // (from the relay's own JSON error body, not the credential-missing
      // guard above -- see relayFetch's comment) rethrows, same guard those
      // three functions use.
      if (e.message.includes('Not connected')) throw e
      // Reset progress to the start of the WASM path so the bar doesn't
      // look like it's rewinding from ~85% back to 0/5%.
      tick('uploading', 5)
    }
    }
  }

  // WASM SDK fallback (no file = called from dropzone, or relay failed)
  const start = Date.now()
  const tick = (s, p, hostKey, transferMs) => { if (onProgress) onProgress({ stage: s, percent: p, elapsed: Date.now() - start, hostKey, transferMs, marks }) }
  // DEBUG DIARY (2026-09-24, "tessera-web-debug-log"): "Start a fresh
  // diary when an Add starts." This IS the true Add-start moment for the
  // WASM path (mirrors ADD STAGE CLOCKS' own t_encode reasoning below --
  // this is simply earlier than that, before even the tunnel-reachable
  // gate). size_bytes only, never the filename, per the packet's own
  // "no filename if that is awkward; size is enough" instruction.
  diaryReset()
  diaryPush('add-start size_bytes=' + (file ? file.size : '-'))
  // BAR HOLD (2026-09-16, "tessera-web-encode-hold"): "The progress
  // bar does not exist yet. No bar during drop, Ready wait, or
  // encoding." The OLD tick('preparing', 0) / tick('uploading', 5)
  // calls that used to run here (BOTH removed from this function's
  // WASM path entirely) each caused web-ui.js's own
  // `subscribe('progress', ...)` to unhide r.progressWrap immediately
  // -- that IS the "bar at 0% before ship" bug, confirmed by reading
  // that subscriber: `if (v) { ...remove('hidden')... }` fires on ANY
  // truthy progress object, stage name irrelevant. NO progress tick
  // fires at all now until the SDK's own onShardUploaded callback
  // below reports the FIRST real landed shard -- so the bar stays
  // hidden for the entire drop / Ready-wait / pre-upload window,
  // satisfying the law with no separate "is this the first tick"
  // check needed in web-ui.js.
  //
  // ENCODING SIGNAL -- UPDATED (2026-09-16, "tessera-web-encoding-
  // word", supersedes "tessera-web-encode-hold"'s "skip, don't
  // fabricate" call below): the encode-hold packet's grep finding
  // still stands -- there is no SDK-level hosts-ready/upload-started
  // EVENT (onShardUploaded is the SDK's only per-shard hook, firing
  // only after a shard has landed; re-confirmed again this packet,
  // same file, same result). What changed is the OPERATOR's own
  // instruction: "The operator read the skip and rejected the blank.
  // They know what the page is doing between 'hosts are in' and
  // 'shards go out'. Show that word." -- i.e. the signal doesn't need
  // to come FROM the SDK; the app's own act of CALLING sdk.upload()
  // (right below) IS the moment named by this packet's own window:
  // "Start: the moment this Add calls sdk.upload(...). That is after
  // Ready. That is when the SDK has (or is fetching) hosts and is
  // encoding shards to send." The one 'encoding...' tick now sits
  // immediately before that call (see below, right after
  // uploadOptions.onShardUploaded is wired) -- not fabricating an SDK
  // signal, just naming the true app-level moment the packet asked
  // for. Still routed to `status` only, never `progress` -- BAR HOLD
  // above is otherwise completely unchanged: no tick reaches
  // `progress` (and therefore r.progressWrap) until the first real
  // onShardUploaded event.
  //
  // (Prior packet's own text, preserved for the grep trail: "Grep the
  // wasm .d.ts / SDK callbacks for a hosts-ready / upload-started
  // signal... If the first named event IS the first shard in flight,
  // skip 'encoding...' rather than lie." Re-grepped
  // sia_storage_wasm.d.ts again this packet [UploadOptions,
  // PackedUploadOptions, Sdk.upload/uploadPacked, the whole file] --
  // still zero onHostsReady/onUploadStarted/onShardUploading-
  // equivalent hook anywhere in this SDK. That finding didn't change;
  // only the app-level definition of "the encoding moment" did, per
  // this packet's explicit instruction above.)

  // GATE (2026-09-14, "tessera-web-native-wt"): the tunnel preflight
  // below (added by "tessera-web-upload-hang") is only meaningful when
  // this browser's WebTransport is shimmed to the /__tunnel__ WebSocket
  // relay -- that's Drop's default path, unchanged. Tessera Web now uses
  // native, unshimmed WebTransport straight to hosts (no Tessera tunnel,
  // no tessera-proxy), so probing for a tunnel that Web deliberately does
  // not have would always fail and block every upload. window.___wtpoly___
  // is set by installWebTransportShim() itself -- true only when the shim
  // actually installed (Drop, or any future non-'idx' initSia() caller),
  // false when Tessera Web's initSia('idx') skipped it. Gate on that,
  // not on a hardcoded app check, so this keeps working correctly if
  // Drop's own shim path ever changes independently of this file.
  if (window.___wtpoly___) {
    const tunnelOk = await checkTunnelReachable()
    if (!tunnelOk) {
      throw new Error(
        'File storage is temporarily unavailable. Please try again in a few minutes.'
      )
    }
  }

  const meta = new TextEncoder().encode(JSON.stringify({
    name: metaName || (file ? file.name : 'upload'),
    mime: file ? (file.type || 'application/octet-stream') : 'application/octet-stream',
  }))
  let obj = new PinnedObject()
  obj.updateMetadata(meta)
  // BAR HOLD (2026-09-16, "tessera-web-encode-hold"): REMOVED the OLD
  // `tick('uploading', 5)` that used to run here, immediately before
  // starting the WASM upload. That was itself a REAL 'uploading'-
  // labeled tick reaching web-ui.js's progress path (unlike the
  // 'encoding...' tick above, which is routed to `status` only) --
  // it unhid the bar at 5% before sdk.upload() had shipped a single
  // shard, which is exactly "the bar appears one tick before the
  // first shard ships" (the actual live-verified root cause of "bar
  // jumps straight to uploading," found by tracing every tick call in
  // this function against a stub sdk, not by inspection alone -- see
  // this packet's own proof log). No tick at all fires between the
  // 'encoding...' tick above and the first real onShardUploaded event
  // below now.
  const stream = file ? file.stream() : new ReadableStream({ start(c) { c.enqueue(new Uint8Array(0)); c.close() } })

  // FIX (2026-09-14, "tessera-web-progress"): "Bar follows shards and pin.
  // No fake timer." The stock SDK's real progress signal is the
  // onShardUploaded option callback (confirmed present in the wasm
  // binary's own export table alongside dataShards/parityShards/
  // maxBufferedSlabs -- this is the SDK's own name, not invented here).
  // 5-90% is real shard-landed progress; 90-100% is the pin phase below.
  //
  // DENOMINATOR FIX (2026-09-17, "tessera-web-progress-denom"): "55/30 on a
  // 250 MiB file. 30 is one slab, not the object." The OLD hardcoded
  // `expectedShards = dataShards + parityShards` (= 30) was correct only
  // for a single-slab file (<= dataShards*SECTOR_SIZE = 40 MiB of user
  // bytes) -- any larger file spans multiple slabs and the true total
  // shard count is a multiple of 30, not a flat 30. Computed ONCE here at
  // Add time via computeExpectedShards() (see that function's own comment
  // for the encodedSize()-based formula and its manual fallback), before
  // sdk.upload() is even called, so the very FIRST onShardUploaded tick
  // already shows the correct M -- not just a value that self-corrects
  // partway through. `file` is null on the dropzone/folder-marker path
  // (see the WASM-fallback stream construction above); computeExpectedShards
  // already returns null for a null/negative size, so M silently falls back
  // to the flat dataShards+parityShards in that case, unchanged from before.
  const dataShards = 10
  const parityShards = 20
  const computedM = file ? computeExpectedShards(file.size, dataShards, parityShards) : null
  // hideDenominator (packet's own instruction 3): "If both [M] paths fail:
  // hide N/M." -- only possible if file.size was somehow present but both
  // encodedSize() AND the manual fallback produced nothing usable (fallback
  // only returns null for a non-positive size, which computeExpectedShards
  // already guards). Kept as an explicit flag rather than silently reusing
  // the old flat-30 guess, matching the packet's "do not print N/30" rule.
  const hideDenominator = !!file && computedM == null
  let expectedShards = computedM != null ? computedM : (dataShards + parityShards)
  let shardsLanded = 0
  // ADD STAGE CLOCKS (2026-09-20, "tessera-web-add-timing"): "Instrument
  // only." marks is a plain mutable object threaded through every tick
  // call below via the 5th tick() arg -- t0 is set by the CALLER
  // (doUpload() in web-ui.js, the true Add-start per this packet's own
  // definition), not here; this function only fills in the marks it can
  // actually see from inside the WASM upload path. t_first/t_last are
  // captured here since onShardUploaded is the only place that knows
  // "this was the first/last shard" without re-deriving it downstream.
  const marks = { t_encode: null, t_first: null, t_last: null, t_pin_start: null, t_pin_ok: null, t_upload_ok: null, expectedShards: null, shardsLanded: 0, lastTicks: [] }
  // DEBUG DIARY: "bag_n if the Add already held a host list; else bag=-."
  // Built purely from hostKeys this wrapper already receives via every
  // onShardUploaded event below -- never a fresh hosts()/GET call. Read
  // at Add-end (both success and fail) to print bag_n + an 8-hex list.
  const bagHosts = new Set()
  // DEBUG DIARY: dt_ms on the per-shard line below is a diary-only delta
  // (Date.now() - the previous onShardUploaded call), separate from the
  // stall watchdog's own lastProgressAt clock further down -- observability
  // bookkeeping only, never read by any control-flow/timer in this file.
  let _diaryLastTickAt = start
  const onShardUploaded = (ev) => {
    // ev shape per the wasm binary's own field names, CONFIRMED against
    // node_modules/@siafoundation/sia-storage/wasm/sia_storage_wasm.d.ts's
    // ShardProgress interface (2026-09-20, "tessera-web-29-of-30" --
    // vendored wasm binary is byte-identical to that package's own wasm,
    // md5-verified): hostKey, shardSize, shardIndex, slabIndex, elapsedMs.
    // computedM (above) is already the authoritative total for this
    // file, computed once before upload started -- the SDK's own
    // per-event expectedShards (if it ever reports one) is now only used
    // as a defensive fallback when computedM itself was unavailable,
    // never allowed to override a value we already know is correct.
    shardsLanded += 1
    marks.shardsLanded = shardsLanded
    // LAST-TICK HOST TRACE (2026-09-20, "tessera-web-29-of-30"): "add
    // the last 3 ticks: i= host=" so a failed Add's console line shows
    // which host never reported tick 30. Capped at 3 (shift the oldest
    // out) -- ShardProgress.shardIndex/hostKey are the exact confirmed
    // fields above, no new signal invented.
    marks.lastTicks.push({ i: (ev && ev.shardIndex), host: (ev && ev.hostKey) })
    if (marks.lastTicks.length > 3) marks.lastTicks.shift()
    if (ev && ev.hostKey) bagHosts.add(ev.hostKey)
    marks.bagHosts = bagHosts
    // ADD STAGE CLOCKS: t_first is the first shard ever seen for this
    // Add; t_last is set once this shard makes shardsLanded reach
    // expectedShards (mirrors the exact WATCHDOG DISARM condition
    // below -- same "last shard" moment, not re-derived twice).
    if (marks.t_first === null) marks.t_first = Date.now()
    if (shardsLanded >= expectedShards && marks.t_last === null) marks.t_last = Date.now()
    if (computedM == null && ev && typeof ev.expectedShards === 'number' && ev.expectedShards > 0) {
      expectedShards = ev.expectedShards
    }
    marks.expectedShards = expectedShards
    const pct = 5 + Math.min(85, Math.round((shardsLanded / expectedShards) * 85))
    // FIX (2026-09-14, "tessera-web-map-progress"): forward the event's
    // own hostKey through onProgress so the caller (web-ui.js) can plot
    // it on the upload map -- this is the exact same live callback field
    // already used for the shard counter above, not a second signal or
    // an extra hosts() call.
    // COPY (2026-09-15, "tessera-web-look-v1", DENOMINATOR FIX 2026-09-17):
    // "Progress: N/M -- do not say 'shards' next to the number." Quiet
    // status: `uploading (N/M)` then `pinning` -- no 'shards'. M is now the
    // real per-file total (see computedM above), not a hardcoded 30.
    // hideDenominator (packet's own instruction 3): if M could not be
    // computed at all, print landed-shard COUNT only, no "/M" -- never a
    // lying denominator.
    //
    // LINE FLOOR (2026-09-16, "tessera-web-encode-hold"): ev.elapsedMs
    // is the SDK's OWN field (ShardProgress.elapsedMs, per
    // sia_storage_wasm.d.ts) -- this shard's real send->finish
    // duration. Forwarded through tick()'s new 4th arg (transferMs) so
    // map.js's shardLanded() can compute "max(5s, real transfer)"
    // without a second timer/clock of its own.
    const stageText = hideDenominator
      ? 'uploading (' + shardsLanded + ')'
      : 'uploading (' + shardsLanded + '/' + expectedShards + ')'
    tick(stageText, pct, ev && ev.hostKey, ev && ev.elapsedMs)
    // DEBUG DIARY (2026-09-24, "tessera-web-debug-log"): "encoding /
    // first shard / M" + the per-shard line ("each onShardUploaded: i=
    // n/M host8= dt_ms= since previous tick"). host8/dt_ms only, per
    // "Debug face: 8-hex only" -- no full key on this line (nothing here
    // needs Copy-only reveal; that's reserved for the fail line's
    // last_host per the packet's own instruction).
    const diaryNow = Date.now()
    const diaryDt = diaryNow - _diaryLastTickAt
    _diaryLastTickAt = diaryNow
    if (shardsLanded === 1) {
      diaryPush('first-shard M=' + expectedShards)
    }
    diaryPush(
      'shard i=' + (ev && ev.shardIndex != null ? ev.shardIndex : '-') +
      ' n=' + shardsLanded + '/' + expectedShards +
      ' host8=' + hex8(ev && ev.hostKey) +
      ' dt_ms=' + diaryDt
    )
  }

  const uploadOptions = { dataShards, parityShards, onShardUploaded }
  // FIX (2026-09-16, "tessera-web-inflight-v2" — REVISES/CORRECTS
  // "tessera-web-inflight" 2026-09-14): the OLD `maxInflight: 10` line
  // that used to sit here has been REMOVED, not just renamed --
  // confirmed via a live recon (2026-09-16) that `maxInflight` was
  // dropped from the SDK's UploadOptions before our installed version
  // (@siafoundation/sia-storage 0.0.14 / wasm crate v0.5.0): absent
  // from the shipped .d.ts, absent from the compiled .wasm's own
  // option-key string table, and confirmed via SiaFoundation's own
  // create-sia-app PR #8 ("drop the maxInflight option it no longer
  // accepts"). It was a silent no-op the entire time it existed here --
  // never threw, never logged, just discarded by the wasm boundary.
  // maxBufferedSlabs (below) is the REAL replacement: it raises the
  // ceiling the SDK's own stock adaptive inflight controller climbs
  // toward, rather than setting any fixed concurrency number ourselves
  // -- see UPLOAD_MAX_BUFFERED_SLABS's own top-of-file comment for the
  // full memory-budget math and revert instructions. Gated on
  // window.___wtpoly___ exactly like the old line was: false only for
  // Tessera Web's native-WebTransport path (initSia('idx') skipped the
  // shim), true for Drop's default shimmed/tunnel path -- Drop's call
  // site through this same shared function is unchanged, still gets
  // plain { dataShards, parityShards, onShardUploaded } with no extra
  // key at all, identical to before this task.
  if (!window.___wtpoly___ && UPLOAD_MAX_BUFFERED_SLABS != null) {
    uploadOptions.maxBufferedSlabs = UPLOAD_MAX_BUFFERED_SLABS
  }

  // FIX (2026-09-15, "tessera-web-folder-create-fail"): "Add must not
  // hang with no error... No 5-minute bar. No silent freeze." The OLD
  // timeoutPromise below raced the ENTIRE upload against a flat
  // 300000ms (5 minute) deadline -- that IS the "5-minute bar" the
  // operator saw, and it does nothing to distinguish a write that
  // never started (occupy 0, the reported bug) from one that is
  // genuinely still running late in a large file's shard sequence.
  // Replaced with a STALL watchdog instead: it resets on every real
  // onShardUploaded event (via lastProgressAt below) and only fires if
  // NO shard has landed within STALL_MS of the write starting, or
  // within STALL_MS of the most recent shard -- a write that is
  // actually making progress can run as long as it needs to; one that
  // has not moved in STALL_MS (occupy 0 the whole time, exactly this
  // bug's own symptom) fails fast and visibly instead of sitting at a
  // frozen percent for up to 5 minutes.
  const STALL_MS = 20000
  let lastProgressAt = Date.now()
  // QUIET ROW (2026-09-23, "tessera-web-live-quiet"): tracks the last
  // time the 10s heartbeat console line (section 2 below) printed, so
  // that line fires on its OWN 10s cadence -- independent of this
  // watchdog's 2s poll interval and reset to 0 the moment a real tick
  // lands (see the quiet-state reset alongside lastProgressAt in
  // onShardUploadedWithWatchdog below), so a fresh stall always waits
  // a full 10s before its first heartbeat rather than inheriting a
  // stale timestamp from an earlier stall on the same Add.
  let lastQuietHeartbeatAt = 0
  // FAIL-CODE (2026-09-23, "tessera-web-fail-code"): expose the exact
  // same lastProgressAt the watchdog already tracks onto marks, so
  // web-ui.js's console.error block can print `quiet_ms` (time since
  // the last real signal) without a second clock. Set here to mirror
  // its initial value; onShardUploadedWithWatchdog below re-syncs it
  // on every real tick.
  marks.lastProgressAt = lastProgressAt
  // WATCHDOG DISARM (2026-09-16, "tessera-web-add-false-fail-after-30of30",
  // M UPDATED 2026-09-17 "tessera-web-progress-denom"): operator report --
  // "progress bar stuck at 30/30, map lines drawn (real shards landed),
  // then 'Could not reach storage hosts. Please try again.'" -- even though
  // every shard had actually shipped. Root cause: this watchdog only resets
  // lastProgressAt on onShardUploaded. Once the LAST shard lands
  // (shardsLanded === expectedShards), no further shard events will EVER
  // fire for this upload -- but the Rust SDK's Upload::finish() (called by
  // sdk.upload() internally, confirmed in
  // /tmp/sia-sdk-rs-full/sia_storage/src/upload.rs's finish()) still has to
  // AWAIT each slab task handle to completion after the last shard send --
  // real post-shard bookkeeping (erasure-coding finalization etc.), not a
  // stuck/hung write. If that legitimately takes longer than STALL_MS after
  // the last shard, this watchdog fired a FALSE failure on an upload that
  // had already fully shipped (and may go on to succeed anyway in the
  // now-abandoned background promise -- see the "no cancel hook" comment
  // below). The watchdog's actual job -- catching a write that never
  // started, the "occupy 0 the whole time" bug it was built for -- is
  // already fully satisfied once all expected shards have landed, so it is
  // disarmed at that point rather than kept racing against finalization
  // time it was never designed to bound.
  //
  // `expectedShards` here is the SAME variable the progress-bar denominator
  // above uses -- i.e. this packet's own computedM for the ACTUAL file size
  // (a multiple of 30 for any multi-slab file), not the old hardcoded flat
  // 30. A 250 MiB upload now only disarms after its real ~210 shards have
  // landed, not after the first 30 -- fixing a would-be new false-failure
  // window the old hardcoded disarm point would have reopened on any
  // multi-slab file once M was corrected above.
  let shardsFullyLanded = false
  // ADD-SETTLED GUARD (2026-09-24, "tessera-web-pin-after-t0t"): "once
  // T0T/T20/T20M has already rejected the Add, a late onShardUploaded
  // must not flip the row to pinning." Set true in this function's own
  // outer `finally` below (the same instant both watchdog timers are
  // cleared) -- i.e. the moment the Promise.race the caller is actually
  // awaiting has settled, win or lose. The real sdk.upload() promise
  // keeps running in the background after that (existing lock-release
  // chain below already handles it) and can still call this very
  // callback with a late/orphan tick; this flag is what stops that
  // orphan tick from silently repainting a stale 'pinning' row with no
  // clock left running behind it (both watchdog setIntervals are
  // already cleared by the time addSettled can ever be true).
  let addSettled = false
  // PIN WATCHDOG (2026-09-19, "tessera-web-pin-watch"): independent of
  // the 20s shard-stall timer above -- arms ONLY once every expected
  // shard has landed (the exact moment the shard-stall timer above
  // disarms itself, never overlapping it). "Last shard landed is not
  // 'done.' Bound the wait to pin." sdk.upload()'s own promise can
  // still hang past Upload::finish() (slab-task bookkeeping) with
  // nothing watching it once shardsFullyLanded flips true -- this is
  // the exact silent-hang bug this packet fixes (recon:
  // tessera-web-upload-3030-stall-report.md). 60s, not 20s: the prior
  // packet (2026-09-16, "tessera-web-add-false-fail-after-30of30")
  // proved a flat 20s falsely failed a large multi-slab file's
  // legitimate finalize wait -- reusing that same short threshold here
  // would silently reopen that exact bug. 60s is long enough to clear
  // realistic finalize time while still bounding the wait instead of
  // leaving it open forever.
  const PIN_STALL_MS = 60000
  let pinWatchStartedAt = null
  const onShardUploadedWithWatchdog = (ev) => {
    // ADD-SETTLED GUARD (2026-09-24, "tessera-web-pin-after-t0t"): checked
    // FIRST, before any bookkeeping below -- once the Add has already
    // settled (T0T/T20/T20M rejected it, or it already resolved), the
    // real sdk.upload() chain can still deliver one more late shard tick
    // in the background. onShardUploaded() below unconditionally calls
    // tick(stageText, ...), which would silently repaint the row back to
    // 'uploading (N/M)' (or, at M/M, 'pinning' with no clock left --
    // both watchdog setIntervals are already cleared by the time
    // addSettled is true) over whatever fail/done state the page is
    // already showing. Log the orphan tick for the debug diary/console
    // and stop -- never call onShardUploaded()/tick() once settled.
    if (addSettled) {
      const lateHost = ev && ev.hostKey
      const lateShards = (marks.shardsLanded || 0) + 1
      console.info(
        'tessera-add-late-shard i=' + (ev && ev.shardIndex != null ? ev.shardIndex : '-') +
        ' host=' + (lateHost || '-') + ' shards=' + lateShards + '/' + expectedShards
      )
      diaryPush(
        'late-shard-after-settle i=' + (ev && ev.shardIndex != null ? ev.shardIndex : '-') +
        ' host8=' + hex8(lateHost) + ' shards=' + lateShards + '/' + expectedShards
      )
      return
    }
    // GAP LOG (2026-09-23, "tessera-web-fail-code" section 3): "printed
    // gap, not a new timer." dt = ms since the PREVIOUS real shard
    // tick (lastProgressAt, read here before this tick overwrites it
    // below) -- the same clock the stall watchdog already maintains,
    // no second timer. Only counts a gap between two REAL shard ticks
    // (priorShardsLanded >= 1 guards out the encode-start-to-first-
    // shard gap, which is not "two onShardUploaded ticks"). Never
    // toasts, never pauses the upload, never counted as a fail --
    // purely an observability print, capped at 40 lines on
    // window.__tesseraAddGaps (shift oldest) per the packet's law.
    const now = Date.now()
    const priorShardsLanded = shardsLanded
    const dt = now - lastProgressAt
    if (priorShardsLanded >= 1 && dt >= 3000) {
      const prevTick = marks.lastTicks.length ? marks.lastTicks[marks.lastTicks.length - 1] : null
      const i = ev && ev.shardIndex
      const host = ev && ev.hostKey
      console.info(
        'tessera-add-gap dt=' + dt + ' i=' + (i != null ? i : '-') +
        ' prev_i=' + (prevTick && prevTick.i != null ? prevTick.i : '-') +
        ' host=' + (host || '-')
      )
      diaryPush(
        'gap dt_ms=' + dt + ' i=' + (i != null ? i : '-') +
        ' prev_i=' + (prevTick && prevTick.i != null ? prevTick.i : '-') +
        ' host8=' + hex8(host)
      )
      window.__tesseraAddGaps = window.__tesseraAddGaps || []
      window.__tesseraAddGaps.push({ dt, i, prev_i: prevTick ? prevTick.i : null, host })
      if (window.__tesseraAddGaps.length > 40) window.__tesseraAddGaps.shift()
    }
    lastProgressAt = now
    marks.lastProgressAt = lastProgressAt
    // QUIET ROW: a real tick just landed, so the row's quiet suffix
    // (added by the stallTimer poll below) is about to be overwritten
    // by onShardUploaded's own plain stageText tick() call right
    // below -- reset the heartbeat clock too so the NEXT stall, if
    // any, gets its own fresh 10s before its first heartbeat line.
    lastQuietHeartbeatAt = 0
    onShardUploaded(ev)
    if (shardsLanded >= expectedShards && !shardsFullyLanded) {
      shardsFullyLanded = true
      // PINNING TICK (2026-09-19, "tessera-web-pin-watch"): "Show
      // pinning when shards are in... Do not wait for sdk.upload() to
      // return. That wait is the hang." This tick fires the MOMENT the
      // last shard lands, not after sdk.upload()'s promise resolves --
      // pinning IS the finalize step per the operator's own
      // correction, so no new status word is introduced; the existing
      // 'pinning' tick (previously only reachable after
      // Promise.race([uploadPromise, stallPromise]) below had already
      // resolved) is reused verbatim, just moved earlier so the label
      // never sits on the stale 'uploading (30/30)' ceiling through
      // this entire wait. No `N/M` passed -- percent 90, same value
      // the later, now-redundant tick used, matching law's "pinning
      // (no N/M, bar may sit)".
      tick('pinning', 90)
      diaryPush('phase pinning shards=' + shardsLanded + '/' + expectedShards)
      pinWatchStartedAt = Date.now()
    }
  }
  uploadOptions.onShardUploaded = onShardUploadedWithWatchdog

  // ENCODING WORD (2026-09-16, "tessera-web-encoding-word"): "The
  // operator read the skip and rejected the blank... Show that word."
  // This is the exact moment named by the packet's own window: "Start:
  // the moment this Add calls sdk.upload(...). That is after Ready.
  // That is when the SDK has (or is fetching) hosts and is encoding
  // shards to send." One tick, stage 'encoding...', percent 0 --
  // routed to `status` only by web-ui.js's caller (see that file's
  // own comment), NEVER to `progress` (progress is what unhides
  // r.progressWrap on any truthy value -- see encode-hold's BAR HOLD
  // comment above). If sdk.upload() itself throws before any shard
  // (caught by doUpload's own try/catch in web-ui.js), the caller's
  // existing fail-sentence path clears `status` and shows the one
  // fixed fail sentence -- this tick does not need its own undo logic
  // for that case, matching the packet's "drop the word and use the
  // existing fail sentence" instruction exactly.
  // ADD STAGE CLOCKS: t_encode is the exact moment named by this
  // packet ("`encoding...` tick / `sdk.upload()` called") -- both
  // happen back-to-back right here, so one Date.now() call covers
  // both without inventing a second, indistinguishable mark.
  //
  // SERIAL LOCK (2026-09-20, "tessera-web-add-overlap-stall"): wait
  // for any PRIOR real upload/pin chain to genuinely finish before
  // this one is allowed to call sdk.upload() at all -- see the lock's
  // own top-of-file comment for the exact hole this closes. Waiting
  // on a resolved-or-rejected lock never itself throws (the .catch
  // below swallows a prior chain's rejection for the purposes of
  // gating only; that prior chain's own caller already saw and
  // handled its own real error through its own normal await/throw
  // path -- this wait only needs to know "has it stopped running",
  // not "did it succeed"). marks.t_encode/tick('encoding...') are
  // deliberately placed AFTER this await -- a queued file waiting on
  // the lock has not truly started yet, so it must not show
  // 'encoding...' (or record t_encode) until its own turn actually
  // begins, matching queue semantics doUpload() already assumes.
  await _realUploadLock.catch(() => {})
  let releaseLock
  _realUploadLock = new Promise(res => { releaseLock = res })
  _realUploadInFlight = true
  marks.t_encode = Date.now()
  tick('encoding\u2026', 0)
  diaryPush('phase encoding')
  const uploadPromise = sdk.upload(obj, stream, uploadOptions)
  // Swallow a later resolve/reject from the abandoned promise once the
  // stall watchdog has already won the race below -- the underlying
  // WASM upload has no documented cancel/AbortController hook (checked
  // sia_storage_wasm.d.ts), so it may keep running in the background;
  // this only prevents an unhandled-rejection console warning, it does
  // not (and cannot, from here) actually stop that background work.
  uploadPromise.catch(() => {})
  // SERIAL LOCK (2026-09-20, "tessera-web-add-overlap-stall"): set by
  // the try block below, synchronously, the moment the real
  // sdk.pinObject(obj) call is actually made -- never a second call.
  // Read by the release chain further down (after the try/finally),
  // which waits on the REAL uploadPromise (never the watchdog race)
  // and, if it resolved, this SAME pin promise -- so the lock only
  // releases once the actual background SDK work has genuinely
  // stopped, matching the top-of-file comment's stated fix.
  let pinPromiseRef = null
  let stallTimer = null
  // TAIL STALL (2026-09-20, "tessera-web-29-of-30"): "28 or 29
  // onShardUploaded ticks, then 20s with no tick 30, T0." Confirmed
  // via node_modules/@siafoundation/sia-storage/wasm/sia_storage_
  // wasm.d.ts (ShardProgress has no partial/total-override field,
  // and the vendored wasm binary is byte-identical to this .d.ts's
  // own package -- md5 3efe5aae0f9ee84af738f78e620749af both places)
  // that a completed slab always ships the full dataShards+
  // parityShards set -- so M=30 stays correct; this is NOT an M bug,
  // it's a genuinely slow LAST host on an otherwise-healthy slab.
  // "One slow tail host on a 4 MiB sector can be late; 20s after 29
  // is how we T0 a live last write." Extends the budget ONLY once
  // near the very end (>= expectedShards - 2, covers both 28/30 and
  // 29/30 per the packet's own instruction), never from shard 1 --
  // an early stall (a write that never really started) still fails
  // at the original 20s.
  const TAIL_STALL_MS = 45000
  const stallBudgetMs = () => (isTailZone(shardsLanded, expectedShards) ? TAIL_STALL_MS : STALL_MS)
  const stallPromise = new Promise((_, reject) => {
    stallTimer = setInterval(() => {
      // See WATCHDOG DISARM comment above: once every expected shard has
      // landed, this watchdog has nothing left to protect against -- the
      // remaining wait is finalize()/pin bookkeeping, not a stalled write.
      // Never reject past that point; let the real uploadPromise settle on
      // its own, however long that legitimately takes.
      if (shardsFullyLanded) { clearInterval(stallTimer); return }
      // QUIET ROW (2026-09-23, "tessera-web-live-quiet"): "shards
      // still dripping often enough to reset lastProgressAt (bag-
      // slow, not a hang)... the page still says uploading (N/M)
      // either way. That is the lie." Paint the quiet age onto the
      // SAME progress row once a real tick has been silent for >=3s,
      // reusing this already-running 2s poll -- no new timer, per
      // law. Only after at least one real shard has landed (never
      // during encoding before the first piece, per the packet's own
      // instruction); stageText mirrors onShardUploaded's own
      // hideDenominator formula exactly, and hostKey/transferMs are
      // left undefined so this synthetic tick never re-plots a map
      // line for the last-landed host. This is a label repaint only --
      // it does not touch lastProgressAt, so it never resets or masks
      // the real stall/tail-stall budget check below.
      const nowQuiet = Date.now()
      const quietMs = nowQuiet - lastProgressAt
      if (shardsLanded >= 1 && quietMs >= 3000) {
        const quietPct = 5 + Math.min(85, Math.round((shardsLanded / expectedShards) * 85))
        const quietStageText = (hideDenominator
          ? 'uploading (' + shardsLanded + ')'
          : 'uploading (' + shardsLanded + '/' + expectedShards + ')'
        ) + ' quiet ' + Math.floor(quietMs / 1000) + 's'
        tick(quietStageText, quietPct)
        // HEARTBEAT CONSOLE (section 2): one line every 10s while
        // quiet, not a fail -- same last-tick fields as
        // tessera-add-fail's own last-3-ticks trace, capped at 60
        // lines on window.__tesseraAddQuiets (shift oldest), no toast.
        if (nowQuiet - lastQuietHeartbeatAt >= 10000) {
          lastQuietHeartbeatAt = nowQuiet
          const lastTick = marks.lastTicks.length ? marks.lastTicks[marks.lastTicks.length - 1] : null
          const last_i = lastTick && lastTick.i != null ? lastTick.i : null
          const last_host = lastTick && lastTick.host ? lastTick.host : null
          console.info(
            'tessera-add-quiet n=' + shardsLanded + '/' + expectedShards +
            ' quiet_ms=' + quietMs +
            ' last_i=' + (last_i != null ? last_i : '-') +
            ' last_host=' + (last_host || '-')
          )
          window.__tesseraAddQuiets = window.__tesseraAddQuiets || []
          window.__tesseraAddQuiets.push({ n: shardsLanded, m: expectedShards, quiet_ms: quietMs, last_i, last_host })
          if (window.__tesseraAddQuiets.length > 60) window.__tesseraAddQuiets.shift()
          diaryPush(
            'quiet n=' + shardsLanded + '/' + expectedShards +
            ' quiet_ms=' + quietMs +
            ' last_i=' + (last_i != null ? last_i : '-') +
            ' last_host8=' + hex8(last_host)
          )
        }
      }
      if (Date.now() - lastProgressAt > stallBudgetMs()) {
        clearInterval(stallTimer)
        reject(new Error('Could not reach storage hosts. Please try again.'))
      }
    }, 2000)
  })
  // PIN WATCHDOG (2026-09-19, "tessera-web-pin-watch"): runs the whole
  // time (started here, alongside the shard-stall watchdog above) but
  // can only actually trip once pinWatchStartedAt is set -- i.e. once
  // shardsFullyLanded flips true in onShardUploadedWithWatchdog above.
  // Before that point it is a permanent no-op, exactly mirroring how
  // the shard-stall watchdog above is a permanent no-op AFTER that same
  // point -- the two never overlap. Covers BOTH remaining awaits this
  // function can still hang on past the last shard: the tail of
  // uploadPromise itself (raced below) and sdk.pinObject() (raced
  // further down) -- one shared timer/threshold for the whole
  // post-shard-landed window, cleared in the same `finally` as the
  // shard-stall timer once either await actually settles.
  let pinStallTimer = null
  const pinStallPromise = new Promise((_, reject) => {
    pinStallTimer = setInterval(() => {
      if (pinWatchStartedAt !== null && Date.now() - pinWatchStartedAt > PIN_STALL_MS) {
        clearInterval(pinStallTimer)
        // Message text only needs to avoid colliding with the stall/
        // ready/connect classifier patterns in web-ui.js's
        // classifyAddFailure() -- sawRealShardProgress is already true
        // by the time this can ever fire (shards landed is the arming
        // condition), so classifyAddFailure() falls through to its
        // `generic` bucket regardless of this exact string, which is
        // what paints the law's required T0 sentence/tag on the page.
        reject(new Error('Pin window timed out before completion.'))
      }
    }, 2000)
  })
  // LOCK-RELEASE-ON-FAIL FIX (2026-09-24, "tessera-web-pin-after-t0t"):
  // "release it on pin-trip the same way a normal fail does." Reading
  // the code as it stood before this packet: the lock-release chain
  // (`uploadPromise.then().finally(() => releaseLock())`) sits AFTER
  // this try/finally, with no catch -- on ANY throw out of the try
  // block (T20/T20M/T0T, and the pin-stall timeout this packet is
  // about), that line was unreachable, so the lock was never released
  // on ANY failure, not just a pin-trip. In practice this went
  // unnoticed because the operator's own habit of hard-refreshing after
  // a fail wipes all in-memory module state (including the stuck
  // lock) anyway -- but it is a real, general bug, not something
  // specific to pin-trip. Fixed generally here (catch + unconditional
  // release + rethrow) so pin-trip's release is really "the same way a
  // normal fail does," because normal fails now actually do it too.
  let raceError = null
  try {
    obj = await Promise.race([uploadPromise, stallPromise, pinStallPromise])
    // ADD STAGE CLOCKS: t_upload_ok is the moment sdk.upload()'s own
    // promise (via this race) settled -- i.e. the exact mark the
    // packet names `t_upload_ok`. Set on the marks object itself so
    // web-ui.js's own later tick('done', ...) call (after this
    // function returns) can read it back with no separate return
    // value/shape change to this function's existing contract.
    marks.t_upload_ok = Date.now()
    // Second race: sdk.pinObject() itself is the other place this
    // window can still hang past the last shard -- same shared
    // pinStallPromise/threshold, not a second independent timer.
    marks.t_pin_start = Date.now()
    // SERIAL LOCK: pinPromise is created ONCE here and referenced by
    // BOTH the watchdog race below (this attempt's own await) AND the
    // lock-release chain after this try/finally -- never a second,
    // duplicate sdk.pinObject() call for the same object.
    const pinPromise = sdk.pinObject(obj)
    pinPromise.catch(() => {})
    pinPromiseRef = pinPromise
    await Promise.race([pinPromise, pinStallPromise])
    marks.t_pin_ok = Date.now()
  } catch (err) {
    raceError = err
  } finally {
    if (stallTimer) clearInterval(stallTimer)
    if (pinStallTimer) clearInterval(pinStallTimer)
    // ADD-SETTLED GUARD: see its own declaration comment above -- this
    // is the exact instant (win or lose) after which a late/orphan
    // onShardUploaded tick must never repaint the row to 'pinning'.
    addSettled = true
  }
  // SERIAL LOCK release (2026-09-20, "tessera-web-add-overlap-stall";
  // extended 2026-09-24 to run on EVERY exit, not just success -- see
  // the LOCK-RELEASE-ON-FAIL FIX comment above): releases only once the
  // REAL underlying chain has genuinely stopped running -- waits on
  // uploadPromise itself (never the watchdog race above), and, if it
  // resolved, on pinPromiseRef (the SAME single sdk.pinObject() call
  // the try block already made, set via pinPromiseRef just above --
  // never a second, duplicate call). This await runs fully
  // independently, in the background, exactly mirroring the
  // pre-existing uploadPromise.catch(() => {}) pattern this file
  // already used for "let it keep running, just don't crash on the
  // unhandled rejection." Unconditional now (moved outside the
  // success-only tail this used to be) so a T20/T20M/T0T/T0P failure
  // releases the lock exactly the same way a clean success does.
  uploadPromise
    .then(() => (pinPromiseRef ? pinPromiseRef.catch(() => {}) : null), () => {})
    .finally(() => { releaseLock(); _realUploadInFlight = false })
  if (raceError) throw raceError
  tick('done', 100)
  return obj
}


// ── folders ─────────────────────────────────────────────
//
// createFolderMarker() REMOVED (2026-09-15,
// "tessera-web-folder-create-fail"): "Stop pinning a marker on New
// folder." This function used to pin a zero-byte object per empty
// folder -- that upload always threw inside the WASM SDK's own
// erasure-coding step (see the block comment above FOLDER_MARKER_MIME
// for the confirmed root cause: encodedSize(0, 10, 20) === 0n, and the
// WASM binary's own "data shards cannot be zero"/"EmptyShard" error
// strings). Empty folders are now tracked virtually via
// addVirtualFolder()/getVirtualFolders()/removeVirtualFolder() above
// -- no SDK call, no upload, no pin, nothing that can throw.

// ── download ────────────────────────────────────────────

export async function getObject(sdk, objectId) {
  return sdk.object(objectId)
}

// DL ERR CLASS (2026-09-26, "tessera-web-debug-dl"): short token from the
// real Error's name/message, truncated to 80 chars, keyed off substrings
// this codebase's own errors/SDK errors are already known to throw
// ("Object not found" thrown explicitly two lines below; "no more hosts
// available" is the exact SDK-fallback phrase this file's own upload path
// already cites verbatim elsewhere) -- never invents a new taxonomy, just
// buckets the existing strings. `other` is the honest default when none
// match, never a guess.
function dlErrClass(e) {
  const msg = String((e && e.message) || e || '').slice(0, 80)
  const low = msg.toLowerCase()
  if (low.includes('not found')) return 'not-found'
  if (low.includes('no more hosts') || low.includes('unknown host') || low.includes('no host')) return 'unknown-host'
  if (low.includes('too few shards') || low.includes('insufficient shard') || low.includes('not enough shard')) return 'too-few-shards'
  if (low.includes('fetch') || low.includes('network') || low.includes('connection') || low.includes('timed out') || low.includes('timeout')) return 'network'
  return 'other'
}

export async function downloadToDisk(sdk, objOrId, filename, onProgress) {
  // DEBUG DIARY (2026-09-26, "tessera-web-debug-dl", extends 2026-09-24
  // "tessera-web-debug-log"): dl-start is the literal first statement of
  // this function, before any await/branch -- "immediate toast with zero
  // shards must still emit dl-start then dl-end fail" is satisfied purely
  // by this ordering plus the try/catch wrapping everything below, no
  // separate zero-shard special case needed. size_bytes comes from the
  // object handle's own .size() ONLY when the caller already passed an
  // object (never a fresh fetch to get it) -- the string-id call site
  // (web-ui.js's onDownload) doesn't have that, so size_bytes=- there,
  // filled in properly by dl-object once the WASM fallback path (if
  // taken) actually retrieves the indexer object below.
  const dlObjectId = typeof objOrId === 'string' ? objOrId : objOrId.id()
  const dlT0 = Date.now()
  let dlFirstTickAt = null
  let dlSizeBytes = null
  try { if (objOrId && typeof objOrId !== 'string' && objOrId.size) dlSizeBytes = objOrId.size() } catch (_) {}
  diaryPush('dl-start obj=' + hex8(dlObjectId) + ' size_bytes=' + (dlSizeBytes != null ? dlSizeBytes : '-'))
  // BAG (Add ticks already in memory this tab): window.__tesseraLastAddBagHosts
  // is written by web-ui.js's own add-end diary lines (both ok and fail),
  // never re-derived or fetched here -- "do not compute this by calling
  // hosts()". No Add this tab yet -> bag=-.
  let dlBagHosts = null
  try {
    if (typeof window !== 'undefined' && window.__tesseraLastAddBagHosts && window.__tesseraLastAddBagHosts.size) {
      dlBagHosts = window.__tesseraLastAddBagHosts
    }
  } catch (_) {}
  const dlBagN = dlBagHosts ? dlBagHosts.size : 0
  const dlBagStr = dlBagHosts ? Array.from(dlBagHosts).map(hex8).join(',') : '-'
  diaryPush('dl-bag bag_n=' + dlBagN + ' bag=' + dlBagStr)
  diaryPush('phase=fetching')

  try {
    if (isDesktop()) {
      const result = await window.tesseraDesktop.siaDownload(dlObjectId)
      if (!result.ok) throw new Error(result.error)
      const savePath = await window.tesseraDesktop.saveFileDialog(filename)
      if (!savePath) { diaryPush('dl-end ok elapsed_ms=' + (Date.now() - dlT0) + ' (cancelled, no save path)'); return }
      diaryPush('phase=saving')
      await window.tesseraDesktop.writeFile(savePath, result.data)
      diaryPush('dl-end ok elapsed_ms=' + (Date.now() - dlT0))
      return
    }

    const objectId = dlObjectId

    // Web: use proxy relay
    try {
    // PERCENT (2026-09-19, "tessera-web-download-progress"): the relay
    // path returns one opaque Blob -- no per-chunk signal exists here
    // (confirmed: relayFetch()/Response.blob() give nothing between
    // request-sent and body-fully-buffered). Per the packet's own
    // instruction 3 ("if neither exists, still reset the bar and count
    // percent from whatever tick you have. Do not fake 100% at click
    // an honest 0% bookend at start and 100% only once the blob has
    // actually finished buffering -- no invented intermediate ticks,
    // and the 100% is real completion, not a click-time lie.
    diaryPush('phase=downloading')
    if (onProgress) onProgress({ percent: 0 })
    const resp = await relayFetch('GET', 'download/' + objectId.replace(/\//g, ''))
    const blob = await resp.blob()
    if (onProgress) onProgress({ percent: 100 })
    diaryPush('phase=saving')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'download'
    a.click()
    URL.revokeObjectURL(url)
    // DEBUG DIARY: relay path never fetches an indexer object handle
    // (no dl-object here -- "obj_hosts=unexposed" would be a lie; there
    // is simply no object in hand on this branch) and has no per-shard
    // hook (single opaque Blob) -- shards=-/- is the honest shape.
    diaryPush('dl-end ok elapsed_ms=' + (Date.now() - dlT0) + ' shards=-/-')
    return
  } catch (e) {
    if (e.message.includes('Not connected')) throw e
  }

  // WASM SDK fallback
  const obj = typeof objOrId === 'string' ? await getObject(sdk, objOrId) : objOrId
  if (!obj) throw new Error('Object not found')
  // MAP INBOUND HOOK (2026-09-15, "tessera-web-look-v1"): "If download
  // does not yet call the map, hook onShardDownloaded the same way
  // write hooks onShardUploaded, with a direction flag. No second
  // hosts(). No new occupy." onShardDownloaded is the SDK's own
  // documented DownloadOptions field (confirmed in
  // node_modules/@siafoundation/sia-storage/wasm/sia_storage_wasm.d.ts
  // -- not invented here, same discovery shape as onShardUploaded's
  // own confirmation). This makes ZERO extra network calls of its own:
  // it observes shards the download was already fetching, exactly like
  // onShardUploaded observes shards the upload was already sending.
  // The relay-fetch path above (the WASM fallback's sibling, used when
  // this account has a __sia__ relay connection) has no equivalent
  // per-shard signal to hook -- it returns a single opaque Blob, so
  // downloads via that path have no inbound map trip; only the WASM
  // fallback path below can light up cyan arcs this packet.
  //
  // PERCENT (2026-09-19, "tessera-web-download-progress"): same
  // computeExpectedShards() formula uploadFile() already uses for its
  // own N/M denominator (10 data + 20 parity, fixed Tessera layout).
  // obj.size() is the SAME PinnedObject accessor listFiles() already
  // calls (files.js line ~694) -- not a new SDK surface. No hosts()
  // call: this only counts shard-landed events the download was
  // already making, exactly like the upload side.
  const dataShards = 10
  const parityShards = 20
  let objSize = 0
  try { objSize = obj.size ? obj.size() : 0 } catch (_) {}
  const computedM = computeExpectedShards(objSize, dataShards, parityShards)
  const expectedShards = computedM != null ? computedM : (dataShards + parityShards)
  let shardsLanded = 0

  // DEBUG DIARY (2026-09-26, "tessera-web-debug-dl"): "obj_hosts= 8-hex
  // list from sector host keys on that object." obj.slabs() is the SAME
  // PinnedObject accessor uploadFile()'s own diary code doesn't need
  // (upload never re-reads its own result), confirmed present on the
  // class itself (not just the plain-object Slab/SealedObject shape) in
  // sia_storage_wasm.d.ts -- each Slab.sectors[].hostKey is a real,
  // already-in-hand field, no /hosts fetch of any kind. Deduped into a
  // Set since redundancy can repeat a host across multiple sectors/slabs
  // of the same object.
  let dlObjHostsFull = null
  try {
    const slabs = obj.slabs ? obj.slabs() : null
    if (slabs && slabs.length) {
      const set = new Set()
      for (const slab of slabs) {
        const sectors = (slab && slab.sectors) || []
        for (const sec of sectors) { if (sec && sec.hostKey) set.add(sec.hostKey) }
      }
      if (set.size) dlObjHostsFull = set
    }
  } catch (e) {
    console.warn('[tessera-web] dl-object slab/sector read failed:', e && e.message)
  }
  {
    const objHostN = dlObjHostsFull ? dlObjHostsFull.size : 0
    // Pane-safe: 8-hex only. Full: real ed25519:... keys, Copy-only,
    // per the packet's own "Debug face: 8-hex on the pane. Full
    // ed25519:... only inside Copy" law -- same two-array split
    // diaryPush() already uses everywhere else in this file.
    const objHosts8 = dlObjHostsFull ? Array.from(dlObjHostsFull).map(hex8).join(',') : 'unexposed'
    const objHostsFullStr = dlObjHostsFull ? Array.from(dlObjHostsFull).join(',') : 'unexposed'
    // intersect_n: count of keys present in BOTH obj_hosts and the
    // dl-bag Set above -- purely a Set/Set comparison on data already in
    // hand, "do not compute this by calling hosts()".
    let intersectPart = ''
    if (dlObjHostsFull && dlBagHosts) {
      let n = 0
      for (const k of dlObjHostsFull) { if (dlBagHosts.has(k)) n++ }
      intersectPart = ' intersect_n=' + n
    }
    diaryPush(
      'dl-object slabs=' + slabs_len(obj) + ' expected_shards=' + expectedShards +
      ' obj_host_n=' + objHostN + ' obj_hosts=' + objHosts8 + intersectPart,
      'dl-object slabs=' + slabs_len(obj) + ' expected_shards=' + expectedShards +
      ' obj_host_n=' + objHostN + ' obj_hosts=' + objHostsFullStr + intersectPart
    )
  }

  if (onProgress) onProgress({ percent: 0 })
  const downloadOptions = onProgress
    ? { onShardDownloaded: (ev) => {
        shardsLanded += 1
        const pct = Math.min(100, Math.round((shardsLanded / expectedShards) * 100))
        // DEBUG DIARY: per-shard tick, 8-hex host only on the pane; full
        // key reserved for Copy via diaryPush's own two-argument split.
        // dt_ms on the FIRST tick doubles as "first shard since dl-start"
        // per the packet's own "first byte / first shard: dt_ms from
        // dl-start" instruction -- same clock, not a second timer.
        if (dlFirstTickAt === null) dlFirstTickAt = Date.now()
        const host8 = hex8(ev && ev.hostKey)
        diaryPush(
          'dl-shard i=' + (ev && ev.shardIndex) + ' n/M=' + shardsLanded + '/' + expectedShards +
          ' host8=' + host8 + ' dt_ms=' + (ev && ev.elapsedMs)
        )
        onProgress({ hostKey: ev && ev.hostKey, direction: 'download', transferMs: ev && ev.elapsedMs, percent: pct })
      } }
    : {}
  // FIX (2026-09-16, "tessera-web-inflight-v2"): operator's stated
  // intent was "concurrency on downloads was intended to be 10" --
  // stock WASM default (DOWNLOAD_MAX_BUFFERED_CHUNKS's own top-of-file
  // comment has the full citation) is already 32, comfortably above
  // 10, so nothing was ever actually capping this below the intended
  // value. Set explicitly anyway so the intent lives in OUR code, not
  // silently in an upstream default we don't control the value of --
  // this line is a documentation/safety net, not a behavior change.
  if (DOWNLOAD_MAX_BUFFERED_CHUNKS != null) {
    downloadOptions.maxBufferedChunks = DOWNLOAD_MAX_BUFFERED_CHUNKS
  }
  diaryPush('phase=downloading')
  const stream = sdk.download(obj, Object.keys(downloadOptions).length ? downloadOptions : undefined)
  const blob = await new Response(stream).blob()
  // Belt-and-braces final tick: rounding in the per-shard formula above
  // can land just under 100 on the very last shard (integer rounding),
  // and a trivial/zero-shard object never fires onShardDownloaded at
  // all -- this guarantees the bar always reaches exactly 100 once the
  // blob has genuinely finished, matching uploadFile()'s own explicit
  // renderProgressBar(100) call on its success path.
  if (onProgress) onProgress({ percent: 100 })
  diaryPush('phase=saving')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename || 'download'; a.click()
  URL.revokeObjectURL(url)
  diaryPush(
    'dl-end ok shards=' + shardsLanded + '/' + expectedShards +
    ' elapsed_ms=' + (Date.now() - dlT0) +
    ' dt_first_ms=' + (dlFirstTickAt != null ? (dlFirstTickAt - dlT0) : '-')
  )
  } catch (e) {
    // DEBUG DIARY: single catch-all around the entire function body
    // (relay attempt, WASM fallback, desktop branch) -- guarantees
    // dl-end fires exactly once per Download regardless of which
    // internal path threw, per "Immediate toast with zero shards must
    // still emit dl-start then dl-end fail so Copy is not blank."
    // Rethrows unchanged so web-ui.js's own catch/toast (the public
    // "Could not download this file. Try again." sentence) is
    // completely untouched -- this is observation only, no control-flow
    // change.
    const errClass = dlErrClass(e)
    const shortMsg = String((e && e.message) || e || '').slice(0, 80)
    diaryPush(
      'dl-end fail err_class=' + errClass + ' elapsed_ms=' + (Date.now() - dlT0),
      'dl-end fail err_class=' + errClass + ' elapsed_ms=' + (Date.now() - dlT0) + ' full=' + shortMsg
    )
    throw e
  }
}

// slabs_len(): tiny helper so the dl-object diary line above reads
// obj.slabs().length once, defensively (never throws into the diary
// line itself if slabs() is ever unavailable on a given object).
function slabs_len(obj) {
  try { const s = obj.slabs ? obj.slabs() : null; return s ? s.length : 0 } catch (_) { return 0 }
}


// ── delete ──────────────────────────────────────────────

export async function deleteFile(sdk, objectId) {
  if (isDesktop()) {
    const result = await window.tesseraDesktop.siaDelete(objectId)
    if (!result.ok) throw new Error(result.error)
    return
  }

  // Web: try proxy relay
  try {
    const resp = await relayFetch('DELETE', 'delete/' + objectId.replace(/\//g, ''))
    const result = await resp.json()
    if (result.ok) return
  } catch (e) {
    if (e.message.includes('Not connected')) throw e
  }

  // WASM SDK fallback
  await sdk.deleteObject(objectId)
}

// ── share ───────────────────────────────────────────────

export async function createShareURL(sdk, objOrId) {
  if (isDesktop()) {
    const objectId = typeof objOrId === 'string' ? objOrId : objOrId.id()
    const result = await window.tesseraDesktop.siaShare(objectId)
    if (!result.ok) throw new Error(result.error)
    return result.url
  }

  const objectId = typeof objOrId === 'string' ? objOrId : objOrId.id()

  /**
   * Wrap a raw SDK share URL into a URL that points to the Tessera
   * download page so recipients can actually download the file.
   *
   * In development the app runs on the Vite dev server (port 5173);
   * in production everything is served from the same origin as this page.
   */
  function wrapShareUrl(rawUrl) {
    const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '')
    return base + '/d/download.html?share=' + encodeURIComponent(rawUrl)
  }

  // Web: use proxy relay
  try {
    const resp = await relayFetch('POST', 'share', JSON.stringify({ objectId }))
    const result = await resp.json()
    if (result.ok) return wrapShareUrl(result.url)
    throw new Error(result.error || 'Share failed')
  } catch (e) {
    if (e.message.includes('Not connected')) throw e
  }

  // WASM SDK fallback
  const obj = typeof objOrId === 'string' ? await getObject(sdk, objOrId) : objOrId
  if (!obj) throw new Error('Object not found')
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const rawUrl = sdk.shareObject(obj, expires)
  return wrapShareUrl(rawUrl)
}

// ── account ─────────────────────────────────────────────

export async function getAccount(sdk) {
  if (isDesktop()) {
    const result = await window.tesseraDesktop.siaAccount()
    if (!result.ok) throw new Error(result.error)
    return { ready: result.ready }
  }
  return sdk.account()
}

// FIX (2026-09-16, "tessera-web-add-hang-map400"): "If waitForReady is
// blocking again, fail visible inside the existing 10s cap -- do not
// raise it." Root cause: the OLD loop's `Date.now() < deadline` check
// only runs BETWEEN iterations -- if a single `await getAccount(sdk)`
// call itself never resolves (sdk.account() hangs, confirmed
// reproducible with a stub sdk whose account() returns a
// never-resolving Promise: the whole call sat past 30s with zero
// resolve/reject, proving the 10s cap doUpload() passes in was NOT
// actually being enforced), the deadline is never reached because
// nothing ever returns to check it -- this IS the exact "occupy 0"
// hang the packet describes, just one layer earlier than the upload
// call itself. Fixed by racing EACH getAccount() call against its own
// per-attempt timeout (deadline - now, so the total wall-clock time
// across all attempts still can't exceed timeoutMs) -- a stuck
// account() call now fails that one attempt instead of hanging the
// entire function forever, and the outer while loop's deadline check
// (now reachable again) still governs the total budget. Verified live
// against the same stub that hung forever before this fix.
export async function waitForReady(sdk, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    let timer = null
    const acct = await Promise.race([
      getAccount(sdk),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('account() timed out')), remaining) }),
    ]).catch(() => null).finally(() => { if (timer) clearTimeout(timer) })
    if (acct && acct.ready) return acct
    if (Date.now() >= deadline) break
    await new Promise(r => setTimeout(r, Math.min(5000, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('Account not ready after ' + (timeoutMs / 1000) + 's')
}

// ── relay init ──────────────────────────────────────────

/**
 * Connect the proxy relay to the indexer using saved credentials.
 * Called by ui.js after a successful connect.  Does nothing in desktop mode.
 */
export async function initRelay() {
  if (isDesktop()) return true
  try {
    const ok = await relayConnect()
    if (ok) console.log('[tessera] relay connected')
    return ok
  } catch (e) {
    console.warn('[tessera] relay unavailable:', e.message)
    return false
  }
}