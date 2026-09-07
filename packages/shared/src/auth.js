// @tessera/shared — authentication

import {
  initSia,
  getIndexerUrl,
  Builder,
  AppKey,
  generateRecoveryPhrase,
  registerSdk,
} from './sdk.js'
import { randomAppId, fromHex, toHex } from './utils.js'

// ── local-storage keys ──────────────────────────────────
const LS = {
  appId: 'tessera.aid',
  appKey: 'tessera.akey',
}

// ── credential helpers ──────────────────────────────────

export function getSaved() {
  return {
    appId: localStorage.getItem(LS.appId) || '',
    appKey: localStorage.getItem(LS.appKey) || '',
  }
}

function persist(partial) {
  if (partial.appId !== undefined) localStorage.setItem(LS.appId, partial.appId)
  if (partial.appKey !== undefined) localStorage.setItem(LS.appKey, partial.appKey)
}

export function clearCredentials() {
  Object.values(LS).forEach(k => localStorage.removeItem(k))
}

// ── login flow ──────────────────────────────────────────

/**
 * Begin the connection flow.
 *
 * Returns { builder, appId, approvalUrl } immediately — the caller
 * must show `approvalUrl` to the user so they can open it and approve.
 * After that, call waitForApprovalAndRegister().
 */
export async function beginConnection() {
  await initSia()

  let { appId } = getSaved()
  if (!appId) {
    appId = randomAppId()
    persist({ appId })
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
export async function completeRegistration(builder, phrase) {
  const sdk = await builder.register(phrase)
  const appKeyHex = toHex(sdk.appKey().export())
  const { appId } = getSaved()
  persist({ appId, appKey: appKeyHex })
  registerSdk(sdk)
  return sdk
}

/**
 * Try to reconnect using saved credentials.
 * Returns SDK or null.
 */
export async function tryReconnect() {
  await initSia()

  const saved = getSaved()
  if (!saved.appKey || !saved.appId) return null

  try {
    const idxUrl = getIndexerUrl()
    const builder = new Builder(idxUrl, {
      appId: saved.appId,
      name: 'Tessera',
      description: 'Tessera storage client',
      serviceUrl: idxUrl,
    })
    const key = new AppKey(fromHex(saved.appKey))
    const sdk = await builder.connected(key)
    if (sdk) registerSdk(sdk)
    return sdk || null
  } catch (e) {
    console.error('Reconnect failed:', e)
    return null
  }
}