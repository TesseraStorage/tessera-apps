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
  const tick = (s, p, hostKey, transferMs) => { if (onProgress) onProgress({ stage: s, percent: p, elapsed: Date.now() - start, hostKey, transferMs }) }
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
  const onShardUploaded = (ev) => {
    // ev shape per the wasm binary's own field names: hostKey, shardSize,
    // shardIndex, slabIndex, elapsedMs. computedM (above) is already the
    // authoritative total for this file, computed once before upload
    // started -- the SDK's own per-event expectedShards (if it ever
    // reports one) is now only used as a defensive fallback when
    // computedM itself was unavailable, never allowed to override a
    // value we already know is correct.
    shardsLanded += 1
    if (computedM == null && ev && typeof ev.expectedShards === 'number' && ev.expectedShards > 0) {
      expectedShards = ev.expectedShards
    }
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
  const onShardUploadedWithWatchdog = (ev) => {
    lastProgressAt = Date.now()
    onShardUploaded(ev)
    if (shardsLanded >= expectedShards) shardsFullyLanded = true
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
  tick('encoding\u2026', 0)
  const uploadPromise = sdk.upload(obj, stream, uploadOptions)
  // Swallow a later resolve/reject from the abandoned promise once the
  // stall watchdog has already won the race below -- the underlying
  // WASM upload has no documented cancel/AbortController hook (checked
  // sia_storage_wasm.d.ts), so it may keep running in the background;
  // this only prevents an unhandled-rejection console warning, it does
  // not (and cannot, from here) actually stop that background work.
  uploadPromise.catch(() => {})
  let stallTimer = null
  const stallPromise = new Promise((_, reject) => {
    stallTimer = setInterval(() => {
      // See WATCHDOG DISARM comment above: once every expected shard has
      // landed, this watchdog has nothing left to protect against -- the
      // remaining wait is finalize()/pin bookkeeping, not a stalled write.
      // Never reject past that point; let the real uploadPromise settle on
      // its own, however long that legitimately takes.
      if (shardsFullyLanded) { clearInterval(stallTimer); return }
      if (Date.now() - lastProgressAt > STALL_MS) {
        clearInterval(stallTimer)
        reject(new Error('Could not reach storage hosts. Please try again.'))
      }
    }, 2000)
  })
  try {
    obj = await Promise.race([uploadPromise, stallPromise])
  } finally {
    if (stallTimer) clearInterval(stallTimer)
  }
  tick('pinning', 90)
  await sdk.pinObject(obj)
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

export async function downloadToDisk(sdk, objOrId, filename, onProgress) {
  if (isDesktop()) {
    const objectId = typeof objOrId === 'string' ? objOrId : objOrId.id()
    const result = await window.tesseraDesktop.siaDownload(objectId)
    if (!result.ok) throw new Error(result.error)
    const savePath = await window.tesseraDesktop.saveFileDialog(filename)
    if (!savePath) return
    await window.tesseraDesktop.writeFile(savePath, result.data)
    return
  }

  const objectId = typeof objOrId === 'string' ? objOrId : objOrId.id()

  // Web: use proxy relay
  try {
    // PERCENT (2026-09-19, "tessera-web-download-progress"): the relay
    // path returns one opaque Blob -- no per-chunk signal exists here
    // (confirmed: relayFetch()/Response.blob() give nothing between
    // request-sent and body-fully-buffered). Per the packet's own
    // instruction 3 ("if neither exists, still reset the bar and count
    // percent from whatever tick you have. Do not fake 100% at click"):
    // an honest 0% bookend at start and 100% only once the blob has
    // actually finished buffering -- no invented intermediate ticks,
    // and the 100% is real completion, not a click-time lie.
    if (onProgress) onProgress({ percent: 0 })
    const resp = await relayFetch('GET', 'download/' + objectId.replace(/\//g, ''))
    const blob = await resp.blob()
    if (onProgress) onProgress({ percent: 100 })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'download'
    a.click()
    URL.revokeObjectURL(url)
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
  if (onProgress) onProgress({ percent: 0 })
  const downloadOptions = onProgress
    ? { onShardDownloaded: (ev) => {
        shardsLanded += 1
        const pct = Math.min(100, Math.round((shardsLanded / expectedShards) * 100))
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
  const stream = sdk.download(obj, Object.keys(downloadOptions).length ? downloadOptions : undefined)
  const blob = await new Response(stream).blob()
  // Belt-and-braces final tick: rounding in the per-shard formula above
  // can land just under 100 on the very last shard (integer rounding),
  // and a trivial/zero-shard object never fires onShardDownloaded at
  // all -- this guarantees the bar always reaches exactly 100 once the
  // blob has genuinely finished, matching uploadFile()'s own explicit
  // renderProgressBar(100) call on its success path.
  if (onProgress) onProgress({ percent: 100 })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename || 'download'; a.click()
  URL.revokeObjectURL(url)
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