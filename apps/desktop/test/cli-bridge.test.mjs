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
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

register(new URL('./electron-loader.mjs', import.meta.url), import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { app } = await import('electron')
const cli = await import('../electron/cli-bridge.mjs')

const WINDOWS = process.platform === 'win32'
const BIN = WINDOWS ? 'tessera-cli.exe' : 'tessera-cli'

// The stub stand-in for the real binary is a POSIX executable (shebang Node
// script). Windows cannot CreateProcess a non-PE `tessera-cli.exe`, and Node
// refuses to spawn a `.cmd`/`.bat` without `shell:true`, which the bridge does
// not use — so the stub-based mapping tests are skipped on win32 and covered
// on Linux/macOS. Windows still exercises the real bundled PE binary via the
// integration test at the bottom (skipped only when none is bundled).
const STUB_SKIP = WINDOWS
  ? 'POSIX CLI stub cannot run on win32; mapping logic covered on Linux/macOS'
  : false

// Behaviour keys off STUB_ACCOUNT_MODE, forwarded through process.env.
const STUB = `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const mode = process.env.STUB_ACCOUNT_MODE || 'ok'
if (mode === 'login_ok') {
  if (process.env.STUB_LOGIN_FILE) {
    fs.writeFileSync(process.env.STUB_LOGIN_FILE, JSON.stringify({
      argv: process.argv.slice(2),
      hasPhrase: !!process.env.TESSERA_PHRASE,
    }))
  }
  process.stdout.write('Magic link requested.\\n')
  process.exit(0)
}
if (mode === 'login_invalid') {
  process.stderr.write('ERROR: the sign-in link is invalid, expired or already used — request a new one with tessera login --email\\n')
  process.exit(1)
}
if (mode === 'no_creds') {
  process.stderr.write("ERROR: no billing credentials — run 'tessera signup' or 'tessera login'\\n")
  process.exit(1)
}
if (mode === 'auth') {
  process.stderr.write("ERROR: authentication failed — run 'tessera signup' or 'tessera login' to sign in\\n")
  process.exit(1)
}
if (mode === 'session') {
  process.stderr.write('ERROR: session expired \\u2014 run \\u0060tessera login --email \\u2026\\u0060\\n')
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
if (mode === 'unknownfail') {
  process.stdout.write('garbage, not a known error')
  process.exit(1)
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

test('account() returns {ok:true, account} from tessera account --json', { skip: STUB_SKIP }, async () => {
  await withStub('ok', async () => {
    const r = await cli.account()
    assert.equal(r.ok, true)
    assert.equal(r.account.billing_id, 'b_1')
    assert.equal(r.account.balance_usd, '7.50')
    assert.equal(r.account.credential, 'agent')
  })
})

test('account() maps a missing credential to no_credentials', { skip: STUB_SKIP }, async () => {
  await withStub('no_creds', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'no_credentials')
  })
})

test('account() maps a rejected credential (authentication failed) to no_credentials', { skip: STUB_SKIP }, async () => {
  await withStub('auth', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'no_credentials')
  })
})

test('account() maps an expired stored session to no_credentials', { skip: STUB_SKIP }, async () => {
  await withStub('session', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'no_credentials')
  })
})

test('account() maps a service error to account_unavailable (retryable, not "login")', { skip: STUB_SKIP }, async () => {
  await withStub('service', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'account_unavailable')
  })
})

test('account() maps an unrecognized non-zero exit with unparseable stdout to account_unavailable', { skip: STUB_SKIP }, async () => {
  await withStub('unknownfail', async () => {
    const r = await cli.account()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'account_unavailable')
  })
})

test('account() maps unparseable stdout to desktop_bridge_error', { skip: STUB_SKIP }, async () => {
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
//
// Gated on the binary actually supporting `account`, not merely existing:
// a matrix leg that only ran `fetch:cli` (no TESSERA_CLI_PATH local build /
// Task 7 stub) must skip rather than fail on "Unknown command: account" when
// the pinned release happens to predate `account`.
const bundled = path.join(__dirname, '..', 'resources', 'cli', BIN)
function bundledAccountSupported() {
  if (!fs.existsSync(bundled)) return false
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-probe-'))
  try {
    execFileSync(bundled, ['account', '--json'], {
      env: { ...process.env, TESSERA_HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch (e) {
    // An older CLI answers "Unknown command: account"; a capable build answers
    // "no billing credentials" and exits 1 too, so probe the output.
    return !/unknown command/i.test(`${e.stdout || ''}${e.stderr || ''}`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}
const BUNDLED_SKIP = !fs.existsSync(bundled)
  ? 'no bundled tessera-cli (run npm run fetch:cli / TESSERA_CLI_PATH)'
  : bundledAccountSupported()
    ? false
    : 'bundled tessera-cli lacks `account` (pinned release; needs a local build or Task 7 stub)'
test(
  'bundled binary reports no_credentials against an empty TESSERA_HOME',
  { skip: BUNDLED_SKIP },
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

// ── Bug 3: in-app magic-link sign-in / recovery ───────────

test('loginStart runs the CLI magic-link request for the email', { skip: STUB_SKIP }, async () => {
  const file = path.join(os.tmpdir(), 'tessera-login-start-' + process.pid + '.json')
  process.env.STUB_LOGIN_FILE = file
  try {
    await withStub('login_ok', async () => {
      const r = await cli.loginStart('user@example.test')
      assert.equal(r.ok, true)
      const seen = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.deepEqual(seen.argv, ['login', '--email', 'user@example.test'])
      assert.equal(seen.hasPhrase, false)
    })
  } finally {
    delete process.env.STUB_LOGIN_FILE
    fs.rmSync(file, { force: true })
  }
})

test('loginVerify passes the phrase only via the environment, never argv', { skip: STUB_SKIP }, async () => {
  const file = path.join(os.tmpdir(), 'tessera-login-verify-' + process.pid + '.json')
  process.env.STUB_LOGIN_FILE = file
  const phrase = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'
  try {
    await withStub('login_ok', async () => {
      const r = await cli.loginVerify('user@example.test', 'tok-123', phrase)
      assert.equal(r.ok, true)
      const seen = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.deepEqual(seen.argv, ['login', '--email', 'user@example.test', '--token', 'tok-123'])
      assert.ok(!seen.argv.includes(phrase), 'phrase must never be in argv')
      assert.equal(seen.hasPhrase, true, 'phrase must reach the CLI via TESSERA_PHRASE')
    })
  } finally {
    delete process.env.STUB_LOGIN_FILE
    fs.rmSync(file, { force: true })
  }
})

test('loginVerify maps an invalid link to safe copy with no secret echo', { skip: STUB_SKIP }, async () => {
  await withStub('login_invalid', async () => {
    const r = await cli.loginVerify('user@example.test', 'tok-secret-value', 'alpha bravo charlie')
    assert.equal(r.ok, false)
    assert.match(r.error, /invalid or has expired/i)
    assert.ok(!r.error.includes('tok-secret-value'), 'the token must never be echoed back')
  })
})

// ── Bug 6: forget clears the shared device config ─────────

test('extractSignInToken accepts a full link, a query string, or a bare token', () => {
  assert.equal(
    cli.extractSignInToken('https://tessera.storage/auth/verify?token=abc123&x=1'),
    'abc123',
  )
  assert.equal(cli.extractSignInToken('token=abc%2B123'), 'abc+123')
  assert.equal(cli.extractSignInToken('  bareTokenValue  '), 'bareTokenValue')
  assert.equal(cli.extractSignInToken(''), '')
  assert.equal(cli.extractSignInToken(null), '')
})

test('forget removes the shared ~/.tessera config (Bug 6)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-forget-'))
  const saved = process.env.TESSERA_HOME
  process.env.TESSERA_HOME = home
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ app_id: 'a', app_key: 'b' }))
    const r = cli.forget()
    assert.equal(r.ok, true)
    assert.equal(fs.existsSync(path.join(home, 'config.json')), false)
  } finally {
    if (saved === undefined) delete process.env.TESSERA_HOME
    else process.env.TESSERA_HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
  }
})
