// @tessera/shared — utilities

/**
 * Format a byte count as a human-readable string (KB / MB / GB).
 */
export function formatBytes(n) {
  const x = Number(n) || 0
  if (x >= 1 << 30) return (x / (1 << 30)).toFixed(2) + ' GB'
  if (x >= 1 << 20) return (x / (1 << 20)).toFixed(2) + ' MB'
  if (x >= 1 << 10) return (x / (1 << 10)).toFixed(1) + ' KB'
  return x + ' B'
}

/**
 * Convert a Uint8Array to a hex string.
 */
export function toHex(buf) {
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Parse a hex string into a Uint8Array.
 */
export function fromHex(s) {
  const h = s.trim().replace(/^0x/, '')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Generate a random 32-byte app ID (hex-encoded).
 */
export function randomAppId() {
  const a = new Uint8Array(32)
  crypto.getRandomValues(a)
  return toHex(a)
}

/**
 * Safe document.getElementById shorthand.
 */
export function $(id) {
  return document.getElementById(id)
}

/**
 * Escape HTML to prevent XSS.
 */
export function esc(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

/**
 * Format a Date or ISO string into a human-readable date.
 */
export function fmtDate(d) {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * Format a Date or ISO string into a human-readable datetime.
 */
export function fmtDateTime(d) {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  return dt.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Return the origin to use for proxy/relay/tunnel requests.
 *
 * In local dev the standalone proxy listens on port 3099, so we return
 * http://localhost:3099 including the deployment page's base path.
 *
 * In production the proxy paths are served through the same origin
 * (nginx reverse-proxies them to the local proxy).  We derive the base
 * path from the current page URL so the app works at any deployment
 * prefix (e.g. /v2/tessera/drop/ on siagate.dev).
 */
export function proxyOrigin() {
  if (typeof window === 'undefined') return 'http://localhost:3099'
  // Electron desktop: the renderer's origin is file:// (or an opaque/custom
  // scheme), never a real http(s) origin -- window.location.hostname is ''
  // there, so it never matched the localhost check below, and the
  // production branch's window.location.origin + pathname math produced a
  // garbage URL (e.g. file:///idx/... or worse). The desktop app always
  // talks to its OWN bundled local proxy (started by electron/main.js) on
  // :3099, exactly like local dev -- so route there unconditionally.
  if (window.tesseraDesktop && window.tesseraDesktop.isDesktop) {
    return 'http://localhost:3099'
  }
  const host = window.location.hostname
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3099'
  }
  // production — same origin; derive base path from page URL
  const path = window.location.pathname  // e.g. /v2/tessera/drop/ or /v2/tessera/drop/index.html
  const base = path.substring(0, path.lastIndexOf('/') + 1)  // /v2/tessera/drop/
  return window.location.origin + base.substring(0, base.length - 1)  // strip trailing /
}