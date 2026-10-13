// Tessera Desktop — tessera-cli bridge (runs in Electron main process)
//
// Gives the desktop app the same folder-sync / watcher functionality as
// tessera-cli, by bundling the real CLI binary and driving it over IPC
// instead of re-implementing its (tested) three-way sync/reconcile/
// tombstone engine in JS. See tessera-cli's ARCHITECTURE.md / TESTING.md.
//
// Identity is shared with the native SDK bridge (sia-bridge.mjs): once the
// app connects, writeConfig() below seeds the SAME ~/.tessera config the
// standalone tessera-cli uses — deliberately NOT an app-isolated home.
//
// Why not isolated: tessera-cli's OS-native watcher (launchd/systemd-user/
// schtasks) is a single global slot per machine, identified by a fixed
// name, entirely independent of TESSERA_HOME. There is only ever one
// watcher process a user can have running. Pointing the desktop app at
// its own isolated TESSERA_HOME let `service install` silently look
// "already installed" (because a standalone tessera-cli install already
// owned that slot) while the real running watcher never learned about the
// desktop app's own sync roots -- folders showed "running" but never
// synced. Sharing ~/.tessera makes both surfaces register roots into, and
// read status from, the one real watcher that can exist.

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { execFile, spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEXER_URL = 'https://index.tessera.storage'

// PKCS8 DER header for a raw Ed25519 private key (fixed, no variable-length
// ASN.1 fields once the OID is Ed25519) — lets Node derive the public half
// from just the 32-byte seed via the standard crypto module, no extra deps.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

// Native NAPI SDK app keys (@siafoundation/sia-storage, Rust) are the raw
// 32-byte Ed25519 seed. tessera-cli's Go SDK (go.sia.tech/siastorage) uses
// Go's ed25519.PrivateKey wire format: 64 bytes = the same 32-byte seed
// followed by its derived 32-byte public key. The two are the SAME
// underlying key material, just a different on-disk length — expand one
// into the other rather than writing a config the CLI would reject.
// Verified byte-for-byte against a real `tessera login` config.json.
function expandToGoEd25519PrivateKeyHex(seedHex) {
  const seed = Buffer.from(seedHex, 'hex')
  if (seed.length !== 32) return seedHex  // already a different length -- leave as-is
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed])
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  const pub = crypto.createPublicKey(priv)
  const pubDer = pub.export({ format: 'der', type: 'spki' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  return Buffer.concat([seed, pubRaw]).toString('hex')
}

// Real, shared tessera-cli home -- same default the standalone CLI uses
// (no TESSERA_HOME override). Mirrors config.go's configDir() exactly:
// $TESSERA_HOME if a caller sets it in their OWN shell, else ~/.tessera.
function cliHome() {
  if (process.env.TESSERA_HOME) return process.env.TESSERA_HOME
  return path.join(app.getPath('home') || os.homedir(), '.tessera')
}

function binName() {
  return process.platform === 'win32' ? 'tessera-cli.exe' : 'tessera-cli'
}

function cliPath() {
  // FIX (found via CDP-driven E2E test, 2026-09-29): app.getAppPath() in
  // dev mode resolved to this file's own directory (electron/), not the
  // app root -- __dirname-relative is reliable in both dev and packaged.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'cli')
    : path.join(__dirname, '..', 'resources', 'cli')
  return path.join(base, binName())
}

// Seed ~/.tessera/config.json with the already-connected app_id/app_key --
// called from sia-bridge.mjs's connect(). Never overwrites an existing
// config: if the user already has a working standalone tessera-cli login
// (any app_id, same account per the shared-watcher design above), that
// login is left alone rather than replaced with the desktop app's own.
export function writeConfig(appIdHex, appKeyHex) {
  const dir = cliHome()
  fs.mkdirSync(dir, { recursive: true })
  const configPath = path.join(dir, 'config.json')
  if (fs.existsSync(configPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (existing && existing.app_id && existing.app_key) return  // already logged in -- leave it
    } catch (_) { /* fall through and write a fresh one */ }
  }
  const config = {
    indexer_url: INDEXER_URL,
    app_id: appIdHex,
    app_key: expandToGoEd25519PrivateKeyHex(appKeyHex),
    phrase_encrypted: '',
    phrase_salt: '',
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

export function hasConfig() {
  return fs.existsSync(path.join(cliHome(), 'config.json'))
}

// READ SIDE OF THE SAME SHARED IDENTITY (2026-09-30): writeConfig() above
// only ever pushed the desktop app's OWN identity into ~/.tessera, and
// only when it was empty. It never made desktop's OWN native-SDK
// connection (the one the file browser/uploads use) actually READ
// ~/.tessera back -- so a standalone CLI login and a desktop recovery of
// the "same account" (same phrase) ended up as two completely different
// app_id/app_key pairs, i.e. two separate, non-overlapping object-storage
// namespaces on the server. This is the real root cause of "CLI shows my
// files, Desktop doesn't, and vice versa": recovering via phrase only
// proves account ownership for approval purposes, it does NOT hand you
// the SAME app_id/app_key another device is already using.
//
// readConfig() lets the renderer boot check ~/.tessera FIRST and, if it
// already holds a real login, adopt that exact app_id/app_key directly
// (see doBoot() in web-ui.js) instead of ever running its own separate
// recovery ceremony. Returns { appId, appKey (32-byte native seed hex,
// reduced back down from the 64-byte Go ed25519 format writeConfig()
// expanded it into) } or null if there's no usable config yet.
export function readConfig() {
  const configPath = path.join(cliHome(), 'config.json')
  if (!fs.existsSync(configPath)) return null
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (_) {
    return null
  }
  if (!cfg || !cfg.app_id || !cfg.app_key) return null
  // Go's ed25519.PrivateKey on-disk format is seed(32B) || pubKey(32B) --
  // the exact inverse of expandToGoEd25519PrivateKeyHex() above. The
  // native/WASM SDK's AppKey wants only the 32-byte seed.
  const seedHex = cfg.app_key.length === 128 ? cfg.app_key.slice(0, 64) : cfg.app_key
  return { appId: cfg.app_id, appKey: seedHex, indexerUrl: cfg.indexer_url || INDEXER_URL }
}

// ── Sign-in + session-backed recovery (Bug 3, 2026-10-13) ─
//
// The desktop app has no browser session cookie, so it cannot call moneyd's
// session-only recovery endpoint itself. Instead it drives the bundled CLI's
// magic-link sign-in, which runs exactly the same session-backed recovery
// (POST /api/v1/credentials/recovery with the magic-link session) and writes
// the shared ~/.tessera config; readConfig()/doBoot() then adopt that exact
// identity. No connect key, no indexd approval page, ever.
//
// The recovery phrase travels only in the child process environment
// (TESSERA_PHRASE), never argv, and is never echoed back to the renderer.

/** Request a magic-link sign-in email. Returns {ok} or {ok:false, error}. */
export function loginStart(email) {
  return run(['login', '--email', email]).then((r) =>
    r.ok ? { ok: true } : { ok: false, error: describeLoginCli(r) })
}

// Accept either the bare token or the WHOLE emailed sign-in link (or a query
// string): the desktop UI asks the user to paste the link, and we pull the
// `token` out of it so no one has to hand-copy a token.
export function extractSignInToken(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  // Full URL (?token=), a bare query string (token=...), or just the token.
  const m = raw.match(/(?:^|[?&])token=([^&\s#]+)/)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch (_) {
      return m[1]
    }
  }
  return raw
}

/** Exchange the emailed link/token for a session and recover/register headlessly. */
export function loginVerify(email, token, phrase) {
  const tokenValue = extractSignInToken(token)
  const childEnv = { ...process.env, TESSERA_PHRASE: phrase }
  return run(['login', '--email', email, '--token', tokenValue], { env: childEnv }).then((r) =>
    r.ok ? { ok: true } : { ok: false, error: describeLoginCli(r) })
}

// Map the CLI's own failures to safe, actionable copy. Deliberately does NOT
// echo raw CLI output: it can contain the email/account id and must never
// carry a phrase/token back into the renderer.
function describeLoginCli(r) {
  const text = `${r.stderr || ''}\n${r.stdout || ''}`
  if (/phrase does not match/i.test(text)) return 'That recovery phrase does not match this account.'
  if (/recovery phrase/i.test(text) && /provide|required/i.test(text)) return 'Enter your 12-word recovery phrase.'
  if (/invalid|expired|already used/i.test(text)) return 'That sign-in link is invalid or has expired. Request a new one and try again.'
  if (/no billing credentials|authentication failed/i.test(text)) return 'Sign-in failed — request a fresh sign-in link and try again.'
  return 'Could not sign in. Check your connection and try again.'
}

/**
 * Forget this device (Bug 6): remove the shared ~/.tessera config that
 * doBoot() would otherwise re-adopt on the next boot. Only the identity is
 * removed (matching the CLI's own `logout`); synced-folder and trash state
 * are left alone.
 */
export function forget() {
  try { fs.rmSync(path.join(cliHome(), 'config.json'), { force: true }) } catch (_) {}
  try { fs.rmdirSync(cliHome()) } catch (_) {}  // only removes if empty
  return { ok: true }
}

// ── Billing account (P6 Decision 6) ──────────────────────
//
// The desktop balance panel is fed by the bundled CLI's `tessera account
// --json`, never by a desktop fetch of /api/v1 (billing.js's desktop branch
// makes no request at all). The CLI prints the moneyd account object
// unchanged (plus a non-secret `credential` tag) on success, and a
// human-readable error on stderr with a non-zero status otherwise.
//
// Error mapping is deliberately narrow so the renderer can pick the right
// state (web-ui.js loadBilling):
//   - no_credentials      → no/expired/unusable credential: "run `tessera
//                           login`". The CLI has three dead-credential
//                           messages: errNoBillingCredentials ("no billing
//                           credentials"), describeBillingError's 401
//                           ("authentication failed"), and errSessionExpired
//                           ("session expired", a stored-but-rejected human
//                           session that the CLI clears). All three mean the
//                           same thing to the user.
//   - desktop_bridge_*    → the bridge itself failed (binary missing, spawn
//                           error, unparseable JSON).
//   - account_unavailable → the CLI reached the service and it answered with
//                           an error (network/server); retryable, so it must
//                           NOT look like a missing credential.
export async function account() {
  const r = await runJSON(['account', '--json'])
  if (r.ok) return { ok: true, account: r.data }
  if (r.error) {
    // Binary not bundled, spawn failure, or the CLI's stdout was not JSON.
    const code = /bad JSON/i.test(r.error)
      ? 'desktop_bridge_error'
      : 'desktop_bridge_unavailable'
    return { ok: false, code, error: r.error }
  }
  const text = `${r.stderr || ''}\n${r.stdout || ''}`
  const code = /no billing credentials|authentication failed|session expired/i.test(text)
    ? 'no_credentials'
    : 'account_unavailable'
  return { ok: false, code, error: (r.stderr || text).trim() }
}

function env() {
  return { ...process.env }
}

function run(args, { input, env: envOverride } = {}) {
  return new Promise((resolve) => {
    const bin = cliPath()
    if (!fs.existsSync(bin)) {
      resolve({ ok: false, error: 'tessera-cli binary not bundled at ' + bin })
      return
    }
    const child = spawn(bin, args, { env: envOverride || env(), stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
    if (input !== undefined) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

function runJSON(args, opts) {
  return run(args, opts).then((r) => {
    if (!r.ok) return r
    try {
      return { ok: true, data: JSON.parse(r.stdout || 'null'), stderr: r.stderr }
    } catch (e) {
      return { ok: false, error: 'bad JSON from tessera-cli: ' + e.message, stdout: r.stdout }
    }
  })
}

// ── Sync folders ─────────────────────────────────────────

export function syncAdd(localPath, remotePrefix) {
  return runJSON(['sync', 'add', localPath, '--as', remotePrefix, '--json'])
}

export function syncList() {
  return runJSON(['sync', 'list', '--json'])
}

export function syncRun(rootId) {
  const args = rootId ? ['sync', '--root', rootId, '--json'] : ['sync', '--json']
  return runJSON(args)
}

export function syncRemove(rootId) {
  // sync remove always prompts interactively ("[y/N]"); tessera-cli has no
  // --yes for this one, so answer the prompt over stdin instead of
  // patching the CLI — same code path, no parallel mechanism.
  return run(['sync', 'remove', rootId], { input: 'y\n' })
}

export function syncConflicts() {
  return runJSON(['sync', 'conflicts', '--json'])
}

// ── Watcher (OS-native service: launchd / systemd-user / schtasks) ──

export async function serviceStatus() {
  const r = await run(['service', 'status'])
  if (!r.ok && r.code === undefined) return { ok: false, error: r.error }
  const text = r.stdout + '\n' + r.stderr
  const installed = /^Installed:/m.test(text)
  const running = /Running:\s*(yes|active|activating)/i.test(text)
  return { ok: true, installed, running, raw: text.trim() }
}

export function serviceInstall() {
  return run(['service', 'install', '--yes'])
}

export function serviceUninstall() {
  return run(['service', 'uninstall', '--yes'])
}

// Ensures the watcher is installed — called automatically right after the
// first synced folder is added, so "installing the watcher" needs no
// separate step from the user.
export async function ensureWatcherInstalled() {
  const status = await serviceStatus()
  if (status.ok && status.installed) return { ok: true, already: true }
  return serviceInstall()
}

// ── Trash / versions (secondary parity panel) ────────────

export function trashList() {
  return runJSON(['trash', 'list', '--json'])
}

export function trashRestore(relPath) {
  return run(['trash', 'restore', relPath])
}

export function versionsList(relPath) {
  return runJSON(['versions', relPath, '--json'])
}

export function versionsRestore(relPath, n) {
  return run(['versions', relPath, '--restore', String(n)])
}
