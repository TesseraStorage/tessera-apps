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

function env() {
  return { ...process.env }
}

function run(args, { input } = {}) {
  return new Promise((resolve) => {
    const bin = cliPath()
    if (!fs.existsSync(bin)) {
      resolve({ ok: false, error: 'tessera-cli binary not bundled at ' + bin })
      return
    }
    const child = spawn(bin, args, { env: env(), stdio: 'pipe' })
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
