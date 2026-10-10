// Headless test harness for electron/cli-bridge.mjs — feeds the desktop
// balance panel's bridge (P6 Decision 6 / Task 6).
//
// What this covers:
//   - `account()` maps `tessera account --json` success into the envelope
//     billing.js's desktop branch consumes ({ok:true, account}).
//   - credential failures come back as `no_credentials` (the "run
//     `tessera login`" state); service/network errors do NOT, so the panel
//     offers a retry instead.
//   - bridge-layer failures (missing binary, unparseable stdout) come back
//     as `desktop_bridge_unavailable` / `desktop_bridge_error`.
//   - one integration check against the real bundled binary with an empty
//     TESSERA_HOME (skipped when fetch:cli has not bundled one).
//
// No Electron runtime: test/electron-loader.mjs substitutes a fake `electron`
// module through a real ESM resolve hook (Module._resolveFilename cannot
// redirect an ESM bare import).

import { register } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./electron-loader.mjs', import.meta.url), import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { app } = await import('electron')
const cli = await import('../electron/cli-bridge.mjs')

const BIN = process.platform === 'win32' ? 'tessera-cli.exe' : 'tessera-cli'

// A tiny stand-in for the real binary: behaviour keys off STUB_ACCOUNT_MODE,
// which the bridge forwards through process.env. It is a Node script so the
// test stays portable across the CI matrix (no shell assumed).
const STUB = `#!/usr/bin/env node
'use strict'
const mode = process.env.STUB_ACCOUNT_MODE || 'ok'
if (mode === 'no_creds') {
  process.stderr.write("ERROR: no billing credentials — run 'tessera signup' or 'tessera login'\\n")
  process.exit(1)
}
if (mode === 'auth') {
  process.stderr.write("ERROR: authentication failed — run 'tessera signup' or 'tessera login' to sign in\\n")
  process.exit(1)
}
if (mode === 'service') {
  process.stderr.write('ERROR: billing API error (HTTP 503): processor_error\\n')
  process.exit(1)
}
if (mode === 'badjson') {
  process.stdout.write('not json')
  process.exit(0)
}
process.stdout.write(JSON.stringify({
  billing_id: 'b_1', kind: 'human', status: 'active', balance_usd: '7.50',
  plan: 'starter', credential: 'agent',
}))
`

function makeStubRoot(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-bridge-stub-'))
  const dir = path.join(root, 'cli')
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, BIN)
  fs.writeFileSync(bin, STUB)
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755)
  process.env.STUB_ACCOUNT_MODE = mode
  return root
}

// Run fn with cliPath() pointed at a throwaway resources dir, then restore.
async function withStub(mode, fn) {
  const savedResources = process.resourcesPath
  const savedPackaged = app.isPackaged
  const savedMode = process.env.STUB_ACCOUNT_MODE
  const root = makeStubRoot(mode)
  app.isPackaged = true
  process.resourcesPath = root
  try {
    await fn()
  } finally {
    app.isPackaged = savedPackaged
    if (savedResources === undefined) delete process.resourcesPath
    else process.resourcesPath = savedResources
    if (savedMode === undefined) delete process.env.STUB_ACCOUNT_MODE
    else process.env.STUB_ACCOUNT_MODE = savedMode
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('account() returns {ok:true, account} from tessera account --json', async () => {
  await withStub('ok', async () => {
    const r = await cli.account()
    assert.equal(r.ok, true)
    assert.equal(r.account.billing_id, 'b_1')
    assert.equal(r.account.balance_usd, '7.50')
    assert.equal(r.account.credential, 'agent')
  })
})

test('account() maps a missing credential to no_credentials', async () => {
  await withStub('no_creds', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'no_credentials')
  })
})

test('account() maps a rejected/expired credential to no_credentials', async () => {
  await withStub('auth', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'no_credentials')
  })
})

test('account() maps a service error to account_unavailable (retryable, not "login")', async () => {
  await withStub('service', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'account_unavailable')
  })
})

test('account() maps unparseable stdout to desktop_bridge_error', async () => {
  await withStub('badjson', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'desktop_bridge_error')
  })
})

test('account() maps a missing bundled binary to desktop_bridge_unavailable', async () => {
  const savedResources = process.resourcesPath
  const savedPackaged = app.isPackaged
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-bridge-empty-'))
  app.isPackaged = true
  process.resourcesPath = empty
  try {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'desktop_bridge_unavailable')
  } finally {
    app.isPackaged = savedPackaged
    if (savedResources === undefined) delete process.resourcesPath
    else process.resourcesPath = savedResources
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

// Integration: the real bundled binary (fetch:cli / TESSERA_CLI_PATH) with an
// empty TESSERA_HOME must report no_credentials offline and deterministically.
const bundled = path.join(__dirname, '..', 'resources', 'cli', BIN)
test(
  'bundled binary reports no_credentials against an empty TESSERA_HOME',
  { skip: !fs.existsSync(bundled) ? 'no bundled tessera-cli (run npm run fetch:cli)' : false },
  async () => {
    const savedHome = process.env.TESSERA_HOME
    const savedPackaged = app.isPackaged
    process.env.TESSERA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-home-'))
    app.isPackaged = false
    try {
      const r = await cli.account()
      assert.equal(r.ok, false)
      assert.equal(r.code, 'no_credentials')
    } finally {
      app.isPackaged = savedPackaged
      fs.rmSync(process.env.TESSERA_HOME, { recursive: true, force: true })
      if (savedHome === undefined) delete process.env.TESSERA_HOME
      else process.env.TESSERA_HOME = savedHome
    }
  },
)
