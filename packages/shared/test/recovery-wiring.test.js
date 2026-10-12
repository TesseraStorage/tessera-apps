// @tessera/shared — structural guard for the seed-phrase recovery wiring.
//
// recovery.test.js covers the real orchestration with injected seams; this
// file guards the parts that only exist once web-ui.js is in play: the web
// recover screen goes through the session-backed recovery material, the
// desktop branch keeps the approval-link flow, and the old dead
// "direct recovery" attempt is gone for good.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WEB_UI = readFileSync(
  fileURLToPath(new URL('../src/web-ui.js', import.meta.url)),
  'utf8',
)
const AUTH = readFileSync(
  fileURLToPath(new URL('../src/auth.js', import.meta.url)),
  'utf8',
)

test('web recover screen asks moneyd for the recovery material', () => {
  const start = WEB_UI.indexOf('async function onRecoverContinue()')
  const end = WEB_UI.indexOf('async function onRecoverContinueDesktop(')
  assert.ok(start !== -1, 'onRecoverContinue must exist')
  assert.ok(end > start, 'the desktop helper must exist')
  const web = WEB_UI.slice(start, end)
  assert.ok(web.includes('fetchRecoveryCredential()'), 'web path must fetch the recovery credential')
  assert.ok(web.includes('recoverWithConnectKey('), 'web path must run the recovery orchestration')
  assert.ok(web.includes('expectedPublicKey'), 'web path must pass the account public key')
  assert.ok(web.includes("cred.status === 401"), 'web path must explain the sign-in requirement')
  assert.ok(web.includes("cred.status === 404"), 'web path must explain the no-identity case')
})

test('desktop keeps the approval-link recovery path', () => {
  const start = WEB_UI.indexOf('async function onRecoverContinueDesktop(')
  assert.ok(start !== -1)
  const desktop = WEB_UI.slice(start, start + 2500)
  assert.ok(desktop.includes('beginRecovery('), 'desktop path must keep beginRecovery')
  assert.ok(desktop.includes('completeRecovery('), 'desktop path must keep completeRecovery')
})

test('the dead direct-recovery attempt is gone', () => {
  assert.ok(!AUTH.includes('Direct recovery failed'), 'the old fallback warning must be gone')
  assert.ok(!AUTH.includes('Try direct recovery first'), 'the old comment must be gone')
  assert.ok(
    AUTH.includes('fetchRecoveryCredential') && AUTH.includes('recoverWithConnectKey'),
    'auth.js must own the session-backed recovery',
  )
})
