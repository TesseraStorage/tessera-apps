// Desktop updater (v0.8.0).
//
// Checks the latest tessera-apps GitHub release, picks the installer that
// matches this platform/arch and package format, downloads it, and verifies
// it against the release's SHA256SUMS before anything is opened or replaced.
// Pure helpers are exported for tests; Electron-specific wiring (timers,
// notifications, IPC) lives in main.js.
//
// Nothing here runs without the user: main.js only *checks* on its own
// (startup + once a day) and notifies; download/install happens when the
// user clicks "Download & install".

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const UPDATE_REPO = 'TesseraStorage/tessera-apps'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export function parseVersion(v) {
  return String(v || '')
    .replace(/^v/, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
}

export function isNewerVersion(latest, current) {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

/**
 * Which release asset updates this install. `format` is the Linux package
 * kind the app was installed from ('appimage' | 'deb' | 'rpm'); ignored
 * elsewhere. Asset names follow electron-builder's
 * `${productName}-${version}-${arch}.${ext}` (arch is "x64"/"arm64", with
 * x86_64/amd64 spellings for deb/rpm/AppImage).
 */
export function pickAsset(assets, platform, arch, format = 'appimage') {
  const list = Array.isArray(assets) ? assets.filter((a) => a && a.name && a.browser_download_url) : []
  const archRe = arch === 'arm64' ? /(arm64|aarch64)/i : /(x64|x86_64|amd64)/i
  let ext
  if (platform === 'darwin') ext = '.dmg'
  else if (platform === 'win32') ext = '.exe'
  else ext = format === 'deb' ? '.deb' : format === 'rpm' ? '.rpm' : '.AppImage'
  const byExt = list.filter((a) => a.name.endsWith(ext))
  return byExt.find((a) => archRe.test(a.name)) || (byExt.length === 1 && platform !== 'darwin' ? byExt[0] : null)
}

/** Parse a `sha256sum` file ("<hex>  <name>" or "<hex> *<name>") into {name: hex}. */
export function parseSha256Sums(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m) out[path.basename(m[2].trim())] = m[1].toLowerCase()
  }
  return out
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

/** Linux package kind this process was started from. */
export function linuxFormat(env = process.env, execPath = process.execPath) {
  if (env.APPIMAGE) return 'appimage'
  if (/^\/(usr|opt)\//.test(execPath)) {
    try { if (fs.existsSync('/usr/bin/rpm') && !fs.existsSync('/usr/bin/dpkg')) return 'rpm' } catch (_) {}
    return 'deb'
  }
  return 'appimage'
}

/**
 * Ask GitHub for the latest release. Returns
 * {current, latest, url, available, asset: {name,url}|null, sumsUrl}.
 * Never throws: a failed check is "no update".
 */
export async function checkForUpdate({ fetchFn, current, platform, arch, format }) {
  const fallback = { current, latest: '', url: '', available: false, asset: null, sumsUrl: '' }
  try {
    const res = await fetchFn(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `tessera-desktop/${current}` },
    })
    if (!res.ok) return fallback
    const data = await res.json()
    const latest = data.tag_name || ''
    const asset = pickAsset(data.assets, platform, arch, format)
    const sums = (data.assets || []).find((a) => a && a.name === 'SHA256SUMS')
    return {
      current,
      latest,
      url: data.html_url || 'https://tessera.storage/downloads',
      available: !!latest && isNewerVersion(latest, current),
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 } : null,
      sumsUrl: sums ? sums.browser_download_url : '',
    }
  } catch {
    return fallback
  }
}

/**
 * Download `info.asset` into `destDir` and verify its SHA-256 against the
 * release's SHA256SUMS. Resolves {ok, file, sha256} or {ok:false, error}.
 * A mismatch deletes the download. `onProgress(received, total)` is optional.
 */
export async function downloadAndVerify(info, destDir, { fetchFn, onProgress } = {}) {
  if (!info || !info.asset) return { ok: false, error: 'No installer for this platform in the latest release — use the download page.' }
  if (!info.sumsUrl) return { ok: false, error: 'The release has no SHA256SUMS, so the download cannot be verified — use the download page.' }
  try {
    const sumsRes = await fetchFn(info.sumsUrl)
    if (!sumsRes.ok) return { ok: false, error: `Could not fetch SHA256SUMS (HTTP ${sumsRes.status}).` }
    const sums = parseSha256Sums(await sumsRes.text())
    const want = sums[info.asset.name]
    if (!want) return { ok: false, error: `SHA256SUMS has no entry for ${info.asset.name}.` }

    fs.mkdirSync(destDir, { recursive: true })
    const file = path.join(destDir, info.asset.name)
    const part = file + '.part'
    const res = await fetchFn(info.asset.url)
    if (!res.ok || !res.body) return { ok: false, error: `Download failed (HTTP ${res.status}).` }
    const total = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0) || info.asset.size || 0
    const out = fs.createWriteStream(part)
    let received = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
      if (onProgress) onProgress(received, total)
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())))
    const got = await sha256File(part)
    if (got !== want) {
      try { fs.unlinkSync(part) } catch (_) {}
      return { ok: false, error: `Checksum mismatch for ${info.asset.name} — the download was discarded.` }
    }
    fs.renameSync(part, file)
    return { ok: true, file, sha256: got }
  } catch (e) {
    return { ok: false, error: `Download failed: ${e && e.message ? e.message : e}` }
  }
}

/** Remember which version we already notified about (one notification per version). */
export function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch (_) { return {} }
}
export function writeState(file, state) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)) } catch (_) {}
}
