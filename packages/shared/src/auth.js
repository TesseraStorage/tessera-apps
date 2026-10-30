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
 * PREFIX (P6 Task 4): threaded through for the same reason.
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

// ── server-assisted recovery (2026-10-12, "seed-phrase recovery") ──
//
// The app key is derived from (phrase, app_id, shared secret); the shared
// secret only exists after an app connect-key approval, and app_id used to be
// a random per-browser value lost with browser data. A seed-only user could
// therefore never recover: the old "direct register" attempt always failed
// and the fallback approval page demanded a connect key ("App password") that
// web users never received.
//
// moneyd now returns the account's own recovery material to an authenticated
// session (POST /api/v1/credentials/recovery): the ORIGINAL app_id, the
// account public key, and the raw connect key. The client rebuilds with the
// original app_id, approves the connection headlessly with the connect key
// (the same POST auth.html's form makes, already used by connectWithInvite),
// and registers the user's phrase -- re-deriving the same app key and the
// same account. The phrase stays the only key material; the connect key only
// authorizes the connection, and the public-key check rejects a wrong phrase
// before anything is persisted.
const RECOVERY_PATH = '/api/v1/credentials/recovery'

function recoveryUrl(base) {
  return (base ? String(base).replace(/\/+$/, '') : '') + RECOVERY_PATH
}

/**
 * Ask moneyd for this session's recovery material.
 * Returns { status, appId?, publicKey?, connectKey?, error? }; transport
 * failures reject. 401 means no authenticated session on this browser;
 * 404 means the billing account has no active storage identity.
 */
export async function fetchRecoveryCredential(opts = {}) {
  const fetchFn = opts.fetchFn || ((...args) => globalThis.fetch(...args))
  const res = await fetchFn(recoveryUrl(opts.apiBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  })
  let body = null
  try {
    body = await res.json()
  } catch (_) {}
  if (res.status === 200) {
    if (body && typeof body.connect_key === 'string' && body.connect_key) {
      return {
        status: 200,
        appId: body.app_id || null,
        publicKey: body.public_key || null,
        connectKey: body.connect_key,
      }
    }
    return { status: 0, error: 'malformed_response' }
  }
  const detailError = body && body.detail && body.detail.error
  if (res.status === 401) return { status: 401, error: detailError || 'unauthorized' }
  if (res.status === 404) return { status: 404, error: detailError || 'identity_not_found' }
  return { status: res.status, error: detailError || 'unexpected' }
}

/**
 * Restore an account on this device with the recovery phrase, given the
 * account's recovery material. Reuses the connectWithInvite mechanics but
 * with the ORIGINAL app_id and the user's own phrase, so the derived app key
 * -- and therefore the account -- is the same one the phrase always had.
 *
 * opts (tests / E2E): initSia, makeBuilder, fetchFn, indexerUrl,
 * expectedPublicKey.
 */
export async function recoverWithConnectKey(
  appId,
  connectKey,
  phrase,
  prefix = 'tessera',
  fetchMode,
  opts = {},
) {
  const init = opts.initSia || initSia
  const makeBuilder =
    opts.makeBuilder || ((url, meta) => new Builder(url, meta))
  const fetchFn = opts.fetchFn || ((...args) => globalThis.fetch(...args))
  const idxUrl = opts.indexerUrl || getIndexerUrl()

  await init(fetchMode)

  const builder = makeBuilder(idxUrl, {
    appId,
    name: 'Tessera',
    description: 'Tessera storage client',
    serviceUrl: idxUrl,
  })

  await builder.requestConnection()
  const approvalUrl = builder.responseUrl()
  const res = await fetchFn(approvalUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + btoa(':' + connectKey),
    },
    body: JSON.stringify({ approve: true }),
  })
  if (!res.ok) {
    throw new Error('approval failed (HTTP ' + res.status + ')')
  }

  await builder.waitForApproval()
  const sdk = await builder.register(phrase)

  // A wrong phrase derives a different key; refuse before persisting so this
  // device never silently becomes a brand-new, empty identity.
  if (opts.expectedPublicKey && typeof sdk.appKey().publicKey === 'function') {
    if (sdk.appKey().publicKey() !== opts.expectedPublicKey) {
      throw new Error('that recovery phrase does not match this account')
    }
  }

  const appKeyHex = toHex(sdk.appKey().export())
  // Same clear-then-persist order as completeRecovery()/completeRegistration().
  clearCredentials(prefix)
  persist({ appId, appKey: appKeyHex }, prefix)
  registerSdk(sdk)
  return sdk
}

// ── recovery flow (approval-link path; desktop only now) ──

/**
 * Start the approval-based recovery flow for a 12-word phrase.
 *
 * NOTE (2026-10-12): the old "direct recovery" attempt here called
 * builder.register() on a disconnected builder, which the SDK always
 * rejects ("must be in approved state") -- it could never succeed. More
 * fundamentally, the app key is NOT derived from the phrase alone; it also
 * needs the server-side app_id and shared secret, so there is no
 * approval-free path to implement. Tessera Web now uses
 * fetchRecoveryCredential()/recoverWithConnectKey() (same account, no app
 * password); this approval-link flow remains for desktop, which has no
 * moneyd session, until its own session-backed recovery ships.
 *
 * Returns { builder, appId, approvalUrl, phrase, needsApproval: true }.
 * The caller shows the approval URL and then calls completeRecovery().
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
  if (onStatus) onStatus('Requesting approval\u2026')

  const approvalBuilder = new Builder(idxUrl, {
    appId,
    name: 'Tessera',
    description: 'Tessera storage client',
    serviceUrl: idxUrl,
  })

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
  // Same latch bug + fix as completeRegistration/recoverWithConnectKey --
  // this is the post-approval completion path (desktop).
  clearCredentials(prefix)
  persist({ appId, appKey: appKeyHex }, prefix)
  registerSdk(sdk)
  return sdk
}