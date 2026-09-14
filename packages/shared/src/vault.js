// @tessera/shared — local unlock-password vault
//
// Wraps the device AppKey at rest behind a password the user sets once,
// on this browser. Tessera never sees this password -- it never leaves
// the browser (no fetch, no URL, no POST body). The 12-word recovery
// phrase remains the only Tessera-independent backup; this password only
// gates THIS browser's already-attached copy of the account.
//
// Reuses the exact same WebCrypto primitives already used for the
// optional encrypted-phrase backup (ui.js's encryptPhraseLocal): PBKDF2-
// SHA256 (100000 iterations) deriving an AES-256-GCM key. One crypto
// stack, not two.
//
// PREFIX (2026-09-14, "tessera-web-v1"): every function takes an
// optional `prefix` (default 'tessera', Drop's exact original key names,
// unchanged) so a second app (Tessera Web, prefix 'tesseraweb') can use
// this same module against its own localStorage keys without ever
// touching tessera.avault/tessera.asalt. Calling with no prefix argument
// reproduces Drop's pre-2026-09-14 behavior byte-for-byte.

function lsKeys(prefix) {
  return {
    vault: prefix + '.avault',  // base64: iv (12B) || ciphertext of the appKey hex string
    salt: prefix + '.asalt',    // base64: 16-byte PBKDF2 salt
  }
}

function toB64(bytes) {
  return btoa(String.fromCharCode(...bytes))
}
function fromB64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

async function deriveKey(password, salt) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  )
}

/**
 * Does a wrapped vault exist on this browser already?
 */
export function hasWrappedVault(prefix = 'tessera') {
  const LS = lsKeys(prefix)
  return !!(localStorage.getItem(LS.vault) && localStorage.getItem(LS.salt))
}

/**
 * Encrypt `appKeyHex` under `password` and persist the wrapped vault.
 * Does NOT touch the plaintext <prefix>.akey key -- caller decides when
 * it is safe to remove it (only after this resolves successfully).
 */
export async function wrapAppKey(appKeyHex, password, prefix = 'tessera') {
  const LS = lsKeys(prefix)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, salt)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(appKeyHex))
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  localStorage.setItem(LS.vault, toB64(combined))
  localStorage.setItem(LS.salt, toB64(salt))
}

/**
 * Decrypt the wrapped vault with `password`, returning the appKey hex
 * string. Throws on a wrong password (AES-GCM auth-tag mismatch) or a
 * missing/corrupt vault -- caller must NOT delete the vault on failure,
 * just let the user try again.
 */
export async function unwrapAppKey(password, prefix = 'tessera') {
  const LS = lsKeys(prefix)
  const combinedB64 = localStorage.getItem(LS.vault)
  const saltB64 = localStorage.getItem(LS.salt)
  if (!combinedB64 || !saltB64) throw new Error('No wrapped vault on this browser.')
  const combined = fromB64(combinedB64)
  const salt = fromB64(saltB64)
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const key = await deriveKey(password, salt)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

/**
 * Remove the wrapped vault (used by the destructive "forget this
 * browser" path only -- never on a wrong-password Unlock attempt).
 */
export function clearVault(prefix = 'tessera') {
  const LS = lsKeys(prefix)
  localStorage.removeItem(LS.vault)
  localStorage.removeItem(LS.salt)
}
