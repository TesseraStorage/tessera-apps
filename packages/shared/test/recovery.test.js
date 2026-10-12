// @tessera/shared — server-assisted seed-phrase recovery.
//
// The recovery flow is: the authenticated browser asks moneyd for the
// account's recovery material (original app_id + connect key + public key),
// then re-runs the headless approval/register flow with the ORIGINAL app_id
// and the user's phrase, re-deriving the same app key. These tests pin the
// wiring with an injected builder/fetch so the real orchestration runs in
// Node; the live end-to-end proof runs against the scratch harness.

import { test } from 'node:test'
import assert from 'node:assert/strict'

function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  }
}

globalThis.localStorage = memoryStorage()
// interceptor.js's registerSdk parks the live SDK on window; the browser has
// one, Node does not.
globalThis.window = globalThis.window || {}

const {
  fetchRecoveryCredential,
  recoverWithConnectKey,
  getSaved,
  clearCredentials,
} = await import('../src/auth.js')

const PREFIX = 'tessera'
const APP_ID = 'a1'.repeat(32)
const PUBLIC_KEY = 'ed25519:' + 'ab'.repeat(32)
const OTHER_KEY = 'ed25519:' + 'cd'.repeat(32)
const SEED = new Uint8Array(32).fill(7)
const PHRASE = 'glare own entire dish exact open theme family harsh room scrap rose'

function fakeSdk(publicKey = PUBLIC_KEY) {
  return {
    appKey: () => ({
      export: () => SEED,
      publicKey: () => publicKey,
    }),
  }
}

function fakeBuilderFactory(log, sdk = fakeSdk()) {
  return (url, meta) => {
    log.push({ step: 'build', url, meta })
    return {
      requestConnection: async () => log.push({ step: 'requestConnection' }),
      responseUrl: () => 'http://indexer.test/auth/connect/req-1',
      waitForApproval: async () => log.push({ step: 'waitForApproval' }),
      register: async (phrase) => {
        log.push({ step: 'register', phrase })
        return sdk
      },
    }
  }
}

function recordingFetch(log, { ok = true, status = 204 } = {}) {
  return async (url, init = {}) => {
    log.push({ step: 'approve', url, method: init.method, headers: init.headers, body: init.body })
    return { ok, status }
  }
}

// ── fetchRecoveryCredential ──────────────────────────────

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

test('fetchRecoveryCredential maps a 200 to the account material', async () => {
  let seen = null
  const result = await fetchRecoveryCredential({
    apiBase: '',
    fetchFn: async (url, init) => {
      seen = { url, init }
      return jsonResponse(200, {
        app_id: APP_ID,
        public_key: PUBLIC_KEY,
        connect_key: 'ck-123',
      })
    },
  })
  assert.equal(seen.url, '/api/v1/credentials/recovery')
  assert.equal(seen.init.method, 'POST')
  assert.deepEqual(result, {
    status: 200,
    appId: APP_ID,
    publicKey: PUBLIC_KEY,
    connectKey: 'ck-123',
  })
})

test('fetchRecoveryCredential maps 401 and 404 to named errors', async () => {
  const unauthorized = await fetchRecoveryCredential({
    apiBase: '',
    fetchFn: async () => jsonResponse(401, { detail: { error: 'unauthorized' } }),
  })
  assert.deepEqual(unauthorized, { status: 401, error: 'unauthorized' })

  const missing = await fetchRecoveryCredential({
    apiBase: '',
    fetchFn: async () =>
      jsonResponse(404, { detail: { error: 'identity_not_found' } }),
  })
  assert.deepEqual(missing, { status: 404, error: 'identity_not_found' })
})

test('fetchRecoveryCredential treats a malformed 200 as an error', async () => {
  const result = await fetchRecoveryCredential({
    apiBase: '',
    fetchFn: async () => jsonResponse(200, { connect_key: '' }),
  })
  assert.equal(result.status, 0)
  assert.equal(result.error, 'malformed_response')
})

// ── recoverWithConnectKey ────────────────────────────────

test('recoverWithConnectKey re-uses the original app id and registers the phrase', async () => {
  clearCredentials(PREFIX)
  const log = []
  const sdk = await recoverWithConnectKey(
    APP_ID,
    'ck-123',
    PHRASE,
    PREFIX,
    'idx',
    {
      initSia: async () => {},
      indexerUrl: 'http://indexer.test',
      makeBuilder: fakeBuilderFactory(log),
      fetchFn: recordingFetch(log),
      expectedPublicKey: PUBLIC_KEY,
    },
  )
  assert.equal(sdk.appKey().publicKey(), PUBLIC_KEY)

  const build = log.find((entry) => entry.step === 'build')
  assert.equal(build.meta.appId, APP_ID)
  assert.deepEqual(
    log.filter((e) => e.step !== 'build').map((e) => e.step),
    ['requestConnection', 'approve', 'waitForApproval', 'register'],
  )
  const approve = log.find((entry) => entry.step === 'approve')
  assert.equal(approve.method, 'POST')
  assert.equal(approve.headers.Authorization, 'Basic ' + btoa(':ck-123'))
  assert.deepEqual(JSON.parse(approve.body), { approve: true })
  const register = log.find((entry) => entry.step === 'register')
  assert.equal(register.phrase, PHRASE)

  const saved = getSaved(PREFIX)
  assert.equal(saved.appId, APP_ID)
  assert.equal(saved.appKey, Array.from(SEED, (b) => b.toString(16).padStart(2, '0')).join(''))
})

test('recoverWithConnectKey refuses a phrase that does not match the account', async () => {
  clearCredentials(PREFIX)
  const log = []
  await assert.rejects(
    recoverWithConnectKey(APP_ID, 'ck-123', PHRASE, PREFIX, 'idx', {
      initSia: async () => {},
      indexerUrl: 'http://indexer.test',
      makeBuilder: fakeBuilderFactory(log, fakeSdk(OTHER_KEY)),
      fetchFn: recordingFetch(log),
      expectedPublicKey: PUBLIC_KEY,
    }),
    /does not match/,
  )
  const saved = getSaved(PREFIX)
  assert.equal(saved.appId, '')
  assert.equal(saved.appKey, '')
})

test('recoverWithConnectKey surfaces a failed approval without registering', async () => {
  clearCredentials(PREFIX)
  const log = []
  await assert.rejects(
    recoverWithConnectKey(APP_ID, 'ck-123', PHRASE, PREFIX, 'idx', {
      initSia: async () => {},
      indexerUrl: 'http://indexer.test',
      makeBuilder: fakeBuilderFactory(log),
      fetchFn: recordingFetch(log, { ok: false, status: 403 }),
      expectedPublicKey: PUBLIC_KEY,
    }),
    /approval failed/,
  )
  assert.equal(log.some((entry) => entry.step === 'register'), false)
  assert.equal(getSaved(PREFIX).appKey, '')
})
