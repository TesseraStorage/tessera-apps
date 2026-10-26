// Task 0.2 — uploadFilesPacked() orchestration guard.
//
// These tests drive the shared packed-upload orchestration with a stub SDK.
// They do NOT prove the WASM binary packs bytes into one slab -- that is the
// live integration test's job. What they prove is the contract the web and
// desktop callers rely on:
//   * one PackedUpload session per multi-file action, not one per file;
//   * a per-file Add failure does not abort the rest of the batch;
//   * finalize()'s objects receive the matching file's metadata in add order;
//   * zero-byte files never enter the packed session (the WASM SDK rejects
//     empty objects);
//   * a finalize count mismatch fails the batch honestly instead of pinning
//     the wrong metadata onto the wrong object;
//   * the real-upload lock is released when the chain settles;
//   * desktop still delegates to the per-file IPC path (Task 0.3 is separate).
//
// files.js reaches for window/localStorage at import time; stub them first so
// the Node import resolves to the WASM/fallback branch, same pattern as
// files-list-paths.test.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.window = globalThis.window || {}
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
}

const { uploadFilesPacked, isRealUploadInFlight, waitForUploadSlot } =
  await import('../src/files.js')

function makeFile(name, size, type = 'application/octet-stream') {
  return {
    name,
    size,
    type,
    stream() { return { fakeStream: name } },
  }
}

function makeStubSdk(opts = {}) {
  const calls = { uploadPacked: 0, add: [], finalize: 0, pinObject: [], options: null }
  const sdk = {
    uploadPacked(options) {
      calls.uploadPacked += 1
      calls.options = options
      const packed = {
        add: async (stream) => {
          const idx = calls.add.length
          calls.add.push(stream)
          if (opts.shardTicks && calls.add.length <= opts.shardTicks) {
            if (options && options.onShardUploaded) {
              options.onShardUploaded({ hostKey: 'host-' + idx, elapsedMs: 7 })
            }
          }
          if (options && options.onWriteAttemptStart && calls.add.length === 1) {
            options.onWriteAttemptStart({ hostKey: 'attempt-host' })
          }
          if (opts.failAddIndexes && opts.failAddIndexes.includes(idx)) {
            throw new Error('add failed at ' + idx)
          }
          return 1
        },
        finalize: async () => {
          calls.finalize += 1
          if (opts.finalizeThrows) throw new Error('finalize boom')
          const failed = opts.failAddIndexes ? opts.failAddIndexes.length : 0
          const count = calls.add.length - failed
          const objects = []
          for (let i = 0; i < count; i++) {
            const holder = { meta: null }
            objects.push({
              _holder: holder,
              updateMetadata: (b) => { holder.meta = b },
              id: () => 'obj-' + i,
              size: () => 1234,
            })
          }
          if (opts.finalizeCountOverride != null) {
            return objects.slice(0, opts.finalizeCountOverride)
          }
          return objects
        },
        cancel: () => { calls.cancelled = true },
      }
      return opts.syncUploadPacked ? packed : Promise.resolve(packed)
    },
    async pinObject(obj) {
      calls.pinObject.push(obj.id())
      if (opts.failPinIndexes && opts.failPinIndexes.includes(calls.pinObject.length - 1)) {
        throw new Error('pin failed at ' + (calls.pinObject.length - 1))
      }
    },
  }
  return { sdk, calls }
}

function metaName(obj) {
  const bytes = obj && obj._holder && obj._holder.meta
  if (!bytes) return null
  return JSON.parse(Buffer.from(bytes).toString('utf8')).name
}

test('a multi-file action uses exactly one packed session and pins every object', async () => {
  const { sdk, calls } = makeStubSdk({ shardTicks: 2 })
  const files = [makeFile('a.txt', 10), makeFile('b.txt', 20), makeFile('c.txt', 30)]
  const seen = []
  const results = await uploadFilesPacked(sdk, files, (p) => seen.push(p), ['dir/a.txt', 'dir/b.txt', 'dir/c.txt'])

  assert.equal(calls.uploadPacked, 1, 'one PackedUpload session for the whole action')
  assert.equal(calls.add.length, 3, 'every non-empty file is added once')
  assert.equal(calls.finalize, 1, 'finalize runs once')
  assert.equal(calls.pinObject.length, 3, 'every finalized object is pinned')
  assert.equal(results.length, 3)
  for (const r of results) {
    assert.equal(r.ok, true)
    assert.match(r.id, /^obj-/)
  }
  // Progress discipline: the bar must not open before real shard progress.
  const stages = seen.map((p) => p.stage)
  assert.equal(stages[0], 'encoding\u2026', 'first tick is the encoding tick')
  assert.ok(stages.includes('attempt'), 'attempt ticks are forwarded')
  assert.ok(stages.includes('uploading'), 'real shard ticks are forwarded')
  assert.ok(stages.includes('pinning'), 'pinning tick fires after finalize')
  assert.equal(stages[stages.length - 1], 'done', 'done tick fires last')
})

test('metadata lands on the matching object in add order', async () => {
  const { sdk } = makeStubSdk({})
  const files = [makeFile('a.txt', 10), makeFile('b.txt', 20), makeFile('c.txt', 30)]
  // Capture metadata at pin time -- the moment the real SDK would persist the
  // descriptor we just attached to the finalized object.
  const objs = []
  sdk.pinObject = async (obj) => { objs.push({ name: metaName(obj), id: obj.id() }) }
  await uploadFilesPacked(sdk, files, null, ['dir/a.txt', 'dir/b.txt', 'dir/c.txt'])
  assert.deepEqual(objs.map((o) => o.name), ['dir/a.txt', 'dir/b.txt', 'dir/c.txt'])
})

test('one failed Add does not abort the rest of the batch', async () => {
  // failAddIndexes is zero-based across ALL add() calls; index 1 = second file
  const { sdk, calls } = makeStubSdk({ failAddIndexes: [1] })
  const files = [makeFile('good-a.txt', 10), makeFile('bad.txt', 20), makeFile('good-b.txt', 30)]
  const results = await uploadFilesPacked(sdk, files, null, ['a', 'bad', 'b'])

  assert.equal(results[0].ok, true, 'first good file survives')
  assert.equal(results[1].ok, false, 'the failed add is reported per-file')
  assert.match(results[1].error, /add failed/)
  assert.equal(results[2].ok, true, 'the rest of the batch still uploads and pins')
  assert.equal(calls.finalize, 1, 'the session still finalizes once')
  assert.equal(calls.pinObject.length, 2, 'only the two surviving objects are pinned')
})

test('zero-byte files are reported per-file and never enter the session', async () => {
  const { sdk, calls } = makeStubSdk({})
  const files = [makeFile('real.txt', 10), makeFile('empty.txt', 0), makeFile('real2.txt', 20)]
  const results = await uploadFilesPacked(sdk, files, null, null)

  assert.equal(calls.add.length, 2, 'only the two non-empty files are added')
  assert.equal(results[1].ok, false)
  assert.match(results[1].error, /Empty files/)
  assert.equal(results[0].ok, true)
  assert.equal(results[2].ok, true)
})

test('an all-zero-byte action starts no session at all', async () => {
  const { sdk, calls } = makeStubSdk({})
  const results = await uploadFilesPacked(sdk, [makeFile('a', 0), makeFile('b', 0)], null, null)
  assert.equal(calls.uploadPacked, 0, 'no PackedUpload is created when nothing can be packed')
  assert.equal(results.length, 2)
  assert.equal(results[0].ok, false)
  assert.equal(results[1].ok, false)
})

test('a finalize failure fails every packed file, not just one', async () => {
  const { sdk } = makeStubSdk({ finalizeThrows: true })
  const files = [makeFile('a', 10), makeFile('b', 20), makeFile('c', 30)]
  const results = await uploadFilesPacked(sdk, files, null, null)
  for (const r of results) {
    assert.equal(r.ok, false)
    assert.match(r.error, /Finalize failed/)
  }
})

test('a finalize count mismatch refuses to pin rather than mislabel objects', async () => {
  const { sdk, calls } = makeStubSdk({ finalizeCountOverride: 1 })
  const files = [makeFile('a', 10), makeFile('b', 20), makeFile('c', 30)]
  const results = await uploadFilesPacked(sdk, files, null, null)
  for (const r of results) {
    assert.equal(r.ok, false)
    assert.match(r.error, /returned 1 objects for 3 files/)
  }
  assert.equal(calls.pinObject.length, 0, 'nothing is pinned when the count is wrong')
})

test('the real-upload lock is released after the packed chain settles', async () => {
  const { sdk } = makeStubSdk({})
  await uploadFilesPacked(sdk, [makeFile('a', 10), makeFile('b', 20)], null, null)
  assert.equal(isRealUploadInFlight(), false, 'flight flag clears when the chain settles')
  // waitForUploadSlot must resolve immediately; a still-held lock would hang
  await Promise.race([
    waitForUploadSlot(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('lock not released')), 1000)),
  ])
})

test('a single file delegates to the existing single-file path', async () => {
  // uploadFilesPacked must not open a PackedUpload for one file -- it delegates
  // to uploadFile so the single-file contract (stall watchdogs, relay fallback,
  // tunnel preflight) stays byte-identical. uploadFile constructs a WASM
  // PinnedObject internally, which cannot run in this Node stub; whatever error
  // it surfaces must NOT be the packed-branch marker.
  const sdk = {
    uploadPacked() { throw new Error('PACKED_BRANCH_WAS_TAKEN') },
  }
  const results = await uploadFilesPacked(sdk, [makeFile('one.txt', 42)], null, null)
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, false, 'the stub cannot complete a real WASM upload')
  assert.doesNotMatch(String(results[0].error), /PACKED_BRANCH_WAS_TAKEN/,
    'a single file must not open a packed session')
})

test('desktop multi-file uses the batch IPC when available', async () => {
  const batches = []
  const priorWindow = globalThis.window
  globalThis.window = {
    ...priorWindow,
    tesseraDesktop: {
      isDesktop: true,
      onUploadProgress: () => () => {},
      siaUploadPacked: async (payload) => {
        batches.push(payload)
        return {
          ok: true,
          results: payload.map((f, i) => ({ ok: true, id: 'batch-' + (i + 1), size: f.size })),
        }
      },
      siaUpload: async () => { throw new Error('per-file IPC must not be used when batch IPC exists') },
    },
  }
  try {
    const sdk = {
      uploadPacked() { throw new Error('sdk.uploadPacked must not be called in the renderer on desktop') },
    }
    const f1 = { name: 'a.txt', size: 4, type: 'text/plain', __desktopBuffer: Buffer.from('aaaa'), __desktopPath: '/tmp/a.txt' }
    const f2 = { name: 'b.txt', size: 4, type: 'text/plain', __desktopBuffer: Buffer.from('bbbb'), __desktopPath: '/tmp/b.txt' }
    const results = await uploadFilesPacked(sdk, [f1, f2], null, null)
    assert.equal(batches.length, 1, 'desktop multi-file uses one batch IPC call')
    assert.equal(batches[0].length, 2)
    assert.deepEqual(results.map((r) => r.ok), [true, true])
    assert.deepEqual(results.map((r) => r.id), ['batch-1', 'batch-2'])
  } finally {
    globalThis.window = priorWindow
  }
})

test('desktop falls back to the per-file IPC path when batch IPC is unavailable', async () => {
  const uploaded = []
  const priorWindow = globalThis.window
  globalThis.window = {
    ...priorWindow,
    tesseraDesktop: {
      isDesktop: true,
      onUploadProgress: () => () => {},
      siaUpload: async (name, buf, mime) => {
        uploaded.push({ name, size: buf.length, mime })
        return { ok: true, id: 'ipc-' + uploaded.length, size: buf.length }
      },
    },
  }
  try {
    const sdk = {
      uploadPacked() { throw new Error('uploadPacked must not be called on desktop') },
    }
    const f1 = { name: 'a.txt', size: 4, type: 'text/plain', __desktopBuffer: Buffer.from('aaaa'), __desktopPath: '/tmp/a.txt' }
    const f2 = { name: 'b.txt', size: 4, type: 'text/plain', __desktopBuffer: Buffer.from('bbbb'), __desktopPath: '/tmp/b.txt' }
    const results = await uploadFilesPacked(sdk, [f1, f2], null, null)
    assert.equal(uploaded.length, 2, 'without batch IPC, desktop falls back to one IPC call per file')
    assert.deepEqual(results.map((r) => r.ok), [true, true])
    assert.deepEqual(results.map((r) => r.id), ['ipc-1', 'ipc-2'])
  } finally {
    globalThis.window = priorWindow
  }
})
