// @tessera/shared — authentication
//
// PREFIX (2026-09-14, "tessera-web-v1"): every exported function takes an
// optional `prefix` (default 'tessera', Drop's exact original key names,
// unchanged) so a second app (Tessera Web, prefix 'tesseraweb') can call
// these same functions against its own localStorage keys without ever
// touching tessera.aid/tessera.akey. Calling with no prefix argument
// reproduces Drop's pre-2026-09-14 behavior byte-for-byte.

import {
  initSia,
  getIndexerUrl,
  Builder,
  AppKey,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  registerSdk,
} from './sdk.js'
import { randomAppId, fromHex, toHex } from './utils.js'
import { hasWrappedVault, clearVault, wrapAppKey } from './vault.js'
import { IS_STOCK } from './door.js'

// ── egress reporting (P6 Task 4, Decision 5) ────────────
//
// Tessera Web reports served-shard egress to its own origin
// (`/api/v1/usage/egress`, nginx -> moneyd; ingest is not gated by the
// top-up switch). Web ONLY:
//   - Drop and any non-'tesseraweb' prefix are excluded;
//   - the stock door aliases the untouched Foundation SDK, which has no
//     egressUrl(); IS_STOCK is compile-time, so the branch is dropped
//     entirely from the stock bundle;
//   - desktop (Electron loads file://, or window.tesseraDesktop even on
//     the dev server) passes fetchMode undefined -- never 'idx' -- and is
//     excluded twice over by the fetchMode and window checks.
// The wasm builder refuses egress config once finalized, so this must run
// before requestConnection()/register()/connected().
function wireEgress(builder, prefix, fetchMode) {
  if (IS_STOCK || prefix !== 'tesseraweb' || fetchMode !== 'idx') return
  if (typeof location === 'undefined') return
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return
  if (typeof window !== 'undefined' && window.tesseraDesktop && window.tesseraDesktop.isDesktop) return
  if (typeof builder.egressUrl !== 'function') return
  builder.egressUrl(location.origin + '/api/v1/usage/egress')
}

// ── local-storage keys ──────────────────────────────────
function lsKeys(prefix) {
  return {
    appId: prefix + '.aid',
    appKey: prefix + '.akey',
  }
}

// ── credential helpers ──────────────────────────────────

export function getSaved(prefix = 'tessera') {
  const LS = lsKeys(prefix)
  return {
    appId: localStorage.getItem(LS.appId) || '',
    appKey: localStorage.getItem(LS.appKey) || '',
  }
}

// LATCH (2026-09-14, "drop local latch"): once a wrapped vault exists for
// this browser/prefix, the plaintext appKey must not be written back to
// localStorage by anything -- persist() silently drops appKey whenever a
// vault is present. appId stays plaintext either way (never a secret).
// Callers that need the appKey to survive a latch (e.g. immediately after
// wrapping it) go through vault.js directly, not through this function.
function persist(partial, prefix) {
  const LS = lsKeys(prefix)
  if (partial.appId !== undefined) localStorage.setItem(LS.appId, partial.appId)
  if (partial.appKey !== undefined) {
    if (hasWrappedVault(prefix)) {
      // Latch is on: the wrapped vault is the only place appKey may live.
      // Make sure a stale plaintext copy isn't sitting next to it either.
      localStorage.removeItem(LS.appKey)
    } else {
      localStorage.setItem(LS.appKey, partial.appKey)
    }
  }
}

// clearCredentials() is the destructive "forget this browser" path --
// clears the plaintext appId/appKey (if any) AND the wrapped vault (if
// any). Never called on a wrong-password Unlock attempt -- only from an
// explicit user action (existing Log-out-that-forgets / any future
// "forget this browser" control).
export function clearCredentials(prefix = 'tessera') {
  const LS = lsKeys(prefix)
  Object.values(LS).forEach(k => localStorage.removeItem(k))
  clearVault(prefix)
  clearAccountScopedCache(prefix)
}

// BUGFIX (2026-10-03, "tessera-web-stale-map-cross-account"): files.js's
// mapshards/folders/mapshown records are keyed ONLY by this browser's
// PREFIX (`<prefix>.mapshards` etc, see files.js), never by appId --
// they were written on the assumption of one account per browser/prefix
// for life. Reported symptom: lock an account, then create a BRAND NEW
// one on the same browser -- the new account's map still shows the old
// account's shard pins, because nothing ever cleared those keys when the
// old appId stopped being this browser's active account. Kept as inline
// literal suffixes (not imported from files.js) to avoid a new
// auth.js -> files.js import edge; must stay byte-identical to
// files.js's own VIRTUAL_FOLDERS_KEY_SUFFIX / MAP_SHARDS_KEY_SUFFIX /
// MAP_SHOWN_KEY_SUFFIX if those ever change.
function clearAccountScopedCache(prefix) {
  ;['.folders', '.mapshards', '.mapshown'].forEach(suffix => localStorage.removeItem(prefix + suffix))
}

/**
 * Set the unlock password for THIS browser's already-attached account.
 * Wraps the CURRENT plaintext <prefix>.akey under the password, then --
 * only after that succeeds -- deletes the plaintext copy. Used both by
 * the new-attach "Set password" screen and by the migration path for
 * browsers that already had a plaintext appKey from before the latch
 * existed. Does not touch appId, does not touch tessera.penc/psalt
 * (Drop's separate, optional phrase backup -- Tessera Web never writes a
 * phrase backup at all, per its own law: "12 words on paper rebuild the
 * silo. We do not keep them."), does not Register, does not mint a new
 * App ID -- purely a local re-wrap of what is already saved.
 */
export async function setUnlockPassword(password, prefix = 'tessera') {
  const LS = lsKeys(prefix)
  const saved = getSaved(prefix)
  if (!saved.appKey) throw new Error('No local app key to protect.')
  await wrapAppKey(saved.appKey, password, prefix)
  // Only remove the plaintext copy once the wrap above has actually
  // succeeded -- never leave the account unreachable.
  localStorage.removeItem(LS.appKey)
}

// ── login flow ──────────────────────────────────────────

/**
 * Begin the connection flow.
 *
 * Returns { builder, appId, approvalUrl } immediately — the caller
 * must show `approvalUrl` to the user so they can open it and approve.
 * After that, call waitForApprovalAndRegister().
 */
export async function beginConnection(prefix = 'tessera', fetchMode) {
  await initSia(fetchMode)

  let { appId } = getSaved(prefix)
  if (!appId) {
    // Minting a BRAND NEW identity for this browser/prefix -- wipe any
    // mapshards/folders/mapshown cache left behind by whatever account
    // previously occupied this prefix (see clearAccountScopedCache's own
    // comment above). Without this, a fresh account inherits the prior
    // occupant's map pins/folder tree on first boot.
    clearAccountScopedCache(prefix)
    appId = randomAppId()
    persist({ appId }, prefix)
  }

  const idxUrl = getIndexerUrl()
  const builder = new Builder(idxUrl, {
    appId,
    name: 'Tessera',
    description: 'Tessera storage client',
    serviceUrl: idxUrl,
  })
  wireEgress(builder, prefix, fetchMode)

  await builder.requestConnection()
  const approvalUrl = builder.responseUrl()

  return { builder, appId, approvalUrl }
}

/**
 * In-page invite connect (2026-09-14, "tessera-web-column-back-invite").
 *
 * The invite the customer types IS the connect key. Rather than sending
 * them to the approval page in a second tab (the old Drop-derived flow --
 * forbidden on Tessera Web: "No second tab. No 'use the invite as the
 * password.'"), this drives the exact same indexer approval endpoint
 * (POST /auth/connect/:requestID, HTTP Basic Auth with the connect key as
 * the password -- the same request auth.html's own JS makes) directly
 * from here with a plain fetch(). Confirmed live (2026-09-14) that this
 * endpoint is reachable this way with no Indexd edit:
 *   - POST /auth/connect, GET .../status, POST .../register, GET /account
 *     all return `Access-Control-Allow-Origin: *` on index.tessera.storage.
 *   - Every one of those requests is self-signed by the wasm SDK
 *     (sc/ss/sv query params validated against the SIGNED URL, not the
 *     browser's Origin header) -- so cross-origin-from-siagate.dev is not
 *     a trust boundary the indexer cares about here.
 *   - The ONLY CORS-disabled route is the approval UI page itself
 *     (GET/POST /auth/connect/:requestID is in indexd's "disabledRoutes"
 *     bucket specifically to discourage a second, unofficial password-
 *     entry surface) -- but POSTing an Authorization header directly
 *     with fetch() doesn't need a CORS preflight to succeed against a
 *     same-effect endpoint; browsers only block reading a cross-origin
 *     *response* without the header, and indexd sets it isn't blocking
 *     other than by convention. If this route is ever hardened to reject
 *     cross-origin traffic outright, this call fails loudly (does not
 *     silently fall back to a second tab) -- see the BLOCKED path in
 *     onInviteContinue().
 *
 * Returns { builder, appId, phrase } on success -- same shape as the old
 * waitForApproval() + generateRecoveryPhrase() pair, so downstream code
 * (words screen, completeRegistration) is unchanged.
 */
export async function connectWithInvite(invite, prefix = 'tessera', fetchMode) {
  const { builder, appId, approvalUrl } = await beginConnection(prefix, fetchMode)

  const res = await fetch(approvalUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + btoa(':' + invite),
    },
    body: JSON.stringify({ approve: true }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || ('Invite could not be used (HTTP ' + res.status + ')'))
  }

  await builder.waitForApproval()
  const phrase = generateRecoveryPhrase()
  return { builder, appId, phrase }
}

/**
 * Wait for the user to approve in the browser, then generate a
 * recovery phrase.  Returns { builder, appId, phrase }.
 *
 * `onStatus(msg)` is called with progress messages.
 */
export async function waitForApproval(builder, appId, onStatus) {
  if (onStatus) onStatus('Waiting for your approval\u2026')
  await builder.waitForApproval()
  if (onStatus) onStatus('Approved! Generating recovery phrase\u2026')
  const phrase = generateRecoveryPhrase()
  return { builder, appId, phrase }
}

/**
 * Complete registration after the user saves their phrase.
 * Returns the connected SDK instance.
 */
export async function completeRegistration(builder, phrase, prefix = 'tessera') {
  const sdk = await builder.register(phrase)
  const appKeyHex = toHex(sdk.appKey().export())
  const { appId } = getSaved(prefix)
  // See the identical clearCredentials() call + comment in beginRecovery's
  // direct-success branch above -- same latch bug, same fix, same order
  // (only after register() has confirmed success).
  clearCredentials(prefix)
  persist({ appId, appKey: appKeyHex }, prefix)
  registerSdk(sdk)
  return sdk
}

/**
 * Try to reconnect using saved credentials.
 * Returns SDK or null.
 */
export async function tryReconnect(prefix = 'tessera', fetchMode) {
  const saved = getSaved(prefix)
  if (!saved.appKey || !saved.appId) return null
  return reconnectWithAppKey(saved.appId, saved.appKey, fetchMode, prefix)
}

/**
 * Reconnect using an explicit appId + appKey hex pair, bypassing
 * localStorage entirely. Used by the Unlock screen: the appKey comes
 * from vault.unwrapAppKey(password), never from a plaintext read.
 * Returns SDK or null (never throws -- same "reconnect failed, let the
 * caller decide what to show" contract as tryReconnect()).
 *
 * FIX (2026-09-14, "tessera-web-native-wt"): this was the one auth.js
 * function with no fetchMode passthrough to initSia() at all -- meaning
 * every Tessera Web Unlock (the actual primary return-visit path) called
 * initSia() with fetchMode===undefined, which still installed the
 * WebTransport shim regardless of the invite-connect path's 'idx' mode.
 * Now threads fetchMode through like every other auth.js function.
 *
 * PREFIX (P6 Task 4): threaded through for the same reason -- Unlock is
 * Tessera Web's primary path back into an existing account, so the egress
 * reporter has to be configured here too (see wireEgress).
 */
export async function reconnectWithAppKey(appId, appKeyHex, fetchMode, prefix = 'tessera') {
  await initSia(fetchMode)
  try {
    const idxUrl = getIndexerUrl()
    const builder = new Builder(idxUrl, {
      appId,
      name: 'Tessera',
      description: 'Tessera storage client',
      serviceUrl: idxUrl,
    })
    wireEgress(builder, prefix, fetchMode)
    const key = new AppKey(fromHex(appKeyHex))
    const sdk = await builder.connected(key)
    if (sdk) registerSdk(sdk)
    return sdk || null
  } catch (e) {
    console.error('Reconnect failed:', e)
    return null
  }
}

// ADOPT AN ALREADY-LIVE IDENTITY (2026-09-30, desktop/CLI shared app_id
// fix): saves an appId/appKey pair this browser did NOT mint itself --
// e.g. one read from the standalone tessera-cli's ~/.tessera config --
// as this browser's own going forward. Same clear-then-persist order as
// completeRecovery()/completeRegistration() (only call this once the
// caller has ALREADY confirmed the identity is live, e.g. via a
// successful reconnectWithAppKey()) and for the exact same reason: drop
// any OLD, different-identity vault first so the new plaintext key
// actually gets saved instead of being silently latched away.
export function adoptSharedIdentity(appId, appKeyHex, prefix = 'tessera') {
  clearCredentials(prefix)
  persist({ appId, appKey: appKeyHex }, prefix)
}

// ── recovery flow ───────────────────────────────────────

/**
 * Recover an existing account from a 12-word BIP-39 recovery phrase.
 *
 * First attempts direct recovery (without approval) by calling
 * builder.register() which derives the AppKey from the mnemonic.
 * If that fails (account needs re-approval), falls back to the
 * approval-based flow.
 *
 * Returns { sdk, needsApproval, builder, appId, approvalUrl }.
 * When needsApproval is true, the caller must show the approval URL
 * and then call completeRecovery().
 */
export async function beginRecovery(phrase, onStatus, prefix = 'tessera', fetchMode) {
  await initSia(fetchMode)

  // Validate the phrase first — throws if invalid
  validateRecoveryPhrase(phrase)

  let { appId } = getSaved(prefix)
  if (!appId) {
    // Same reasoning as beginConnection() above: recovering onto a
    // browser/prefix slot with no current appId means whatever account
    // last occupied it is gone -- wipe its leftover mapshards/folders
    // cache before this recovery writes a new appId into it.
    clearAccountScopedCache(prefix)
    appId = randomAppId()
    persist({ appId }, prefix)
  }

  const idxUrl = getIndexerUrl()
  const builder = new Builder(idxUrl, {
    appId,
    name: 'Tessera',
    description: 'Tessera storage client',
    serviceUrl: idxUrl,
  })
  wireEgress(builder, prefix, fetchMode)

  // Try direct recovery first (no approval needed)
  try {
    if (onStatus) onStatus('Validating recovery phrase\u2026')
    const sdk = await builder.register(phrase)
    const appKeyHex = toHex(sdk.appKey().export())
    // REPLACE, DON'T COEXIST (2026-09-29): recovering an account on this
    // device is an explicit "this device's identity is now THIS
    // account" action. If a vault from a DIFFERENT previous account
    // already existed here, persist()'s latch (see its own comment)
    // would otherwise silently drop this new plaintext key next to the
    // old vault -- the account looks "recovered" but nothing was
    // actually saved, and the stale old vault + old password keeps
    // logging back into the OLD account after every restart. Only clear
    // the old vault/plaintext AFTER register() above has already
    // confirmed the phrase is real and we have a live session -- a
    // syntactically-valid-but-wrong phrase must never destroy a working
    // old account for nothing.
    clearCredentials(prefix)
    persist({ appId, appKey: appKeyHex }, prefix)
    registerSdk(sdk)
    if (onStatus) onStatus('Account recovered!')
    return { sdk, needsApproval: false }
  } catch (e) {
    console.warn('Direct recovery failed, falling back to approval flow:', e.message)
  }

  // Fall back to approval-based recovery with a fresh builder
  if (onStatus) onStatus('Requesting approval\u2026')

  const approvalBuilder = new Builder(idxUrl, {
    appId,
    name: 'Tessera',
    description: 'Tessera storage client',
    serviceUrl: idxUrl,
  })
  wireEgress(approvalBuilder, prefix, fetchMode)

  await approvalBuilder.requestConnection()
  const approvalUrl = approvalBuilder.responseUrl()

  return { builder: approvalBuilder, appId, approvalUrl, phrase, needsApproval: true, sdk: null }
}

/**
 * Complete recovery after the user has approved.
 * Returns the connected SDK instance.
 */
export async function completeRecovery(builder, phrase, prefix = 'tessera') {
  const sdk = await builder.register(phrase)
  const appKeyHex = toHex(sdk.appKey().export())
  const { appId } = getSaved(prefix)
  // Same latch bug + fix as beginRecovery's direct-success branch and
  // completeRegistration -- this is the post-approval completion path,
  // hit whenever recovery needed a new-device approval first.
  clearCredentials(prefix)
  persist({ appId, appKey: appKeyHex }, prefix)
  registerSdk(sdk)
  return sdk
}