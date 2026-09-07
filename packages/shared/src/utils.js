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