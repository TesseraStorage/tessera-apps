// Item 3 (2026-10-13, "files-view-nested-paths"): listFiles() must surface the
// FULL logical path so the Files view nests folders. The CLI/sync engine pins
// {name:<basename>, tessera:{path:<full path>}}; the old reader kept `name`
// alone, so every synced file (e.g. tessera/tessera/x.heic) flattened onto its
// bare basename at the root. Web's own uploads store the full path in `name`,
// so the descriptor path must win WHEN PRESENT but `name` must still be used
// for objects that predate it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// files.js reaches for `window`/`localStorage` in its relay + desktop guards;
// stub them so the Node import resolves to the WASM fallback path.
globalThis.window = globalThis.window || {}
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
}

const { listFiles, computeFolderView } = await import('../src/files.js')

const T = Date.parse('2026-10-13T16:00:00Z')

function cliObject(id, basename, fullPath, size) {
  return {
    id, deleted: false, updatedAt: T,
    object: {
      size: () => size,
      metadata: () => new TextEncoder().encode(JSON.stringify({
        name: basename, v: 1, tessera: { path: fullPath, sha256: 'x', size },
      })),
    },
  }
}
function webObject(id, fullPath, size) {
  return {
    id, deleted: false, updatedAt: T,
    object: {
      size: () => size,
      metadata: () => new TextEncoder().encode(JSON.stringify({ name: fullPath, mime: 'image/heic' })),
    },
  }
}
function sdkFrom(objs) {
  return { async objectEvents(cursor) { return cursor ? [] : objs } }
}

test('listFiles surfaces the CLI descriptor path, not the bare name', async () => {
  const files = await listFiles(sdkFrom([
    cliObject('a', '20260925_131242.heic', 'tessera/tessera/20260925_131242.heic', 1040000),
  ]))
  assert.equal(files[0].name, 'tessera/tessera/20260925_131242.heic')
})

test('a synced nested file nests under its real folders in the Files view', async () => {
  const files = await listFiles(sdkFrom([
    cliObject('a', 'x.heic', 'tessera/tessera/x.heic', 10),
    cliObject('b', 'answer.md', 'answer.md', 4),
  ]))
  const root = computeFolderView(files, '', [])
  assert.deepEqual(root.folders.map((f) => f.name), ['tessera'])
  assert.deepEqual(root.files.map((f) => f.displayName), ['answer.md'])

  const lvl1 = computeFolderView(files, 'tessera', [])
  assert.deepEqual(lvl1.folders.map((f) => f.name), ['tessera'])
  const lvl2 = computeFolderView(files, 'tessera/tessera', [])
  assert.deepEqual(lvl2.files.map((f) => f.displayName), ['x.heic'])
})

test('web-uploaded files (full path already in name) still nest', async () => {
  const files = await listFiles(sdkFrom([webObject('w', 'Photos/vacation.jpg', 5)]))
  assert.equal(files[0].name, 'Photos/vacation.jpg')
  const root = computeFolderView(files, '', [])
  assert.deepEqual(root.folders.map((f) => f.name), ['Photos'])
})

test('an object with neither descriptor nor name keeps its id placeholder', async () => {
  const files = await listFiles(sdkFrom([{
    id: 'abcdef0123456789', deleted: false, updatedAt: T,
    object: { size: () => 1, metadata: () => new Uint8Array() },
  }]))
  assert.match(files[0].name, /^abcdef012345\u2026$/)
})
