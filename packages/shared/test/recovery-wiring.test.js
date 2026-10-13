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
  const end = WEB_UI.indexOf('// ── desktop sign-in')
  assert.ok(start !== -1, 'onRecoverContinue must exist')
  assert.ok(end > start, 'the desktop sign-in section must exist')
  const web = WEB_UI.slice(start, end)
  assert.ok(web.includes('fetchRecoveryCredential()'), 'web path must fetch the recovery credential')
  assert.ok(web.includes('recoverWithConnectKey('), 'web path must run the recovery orchestration')
  assert.ok(web.includes('expectedPublicKey'), 'web path must pass the account public key')
  assert.ok(web.includes("cred.status === 401"), 'web path must explain the sign-in requirement')
  assert.ok(web.includes("cred.status === 404"), 'web path must explain the no-identity case')
})

test('desktop uses the in-app magic-link sign-in, not the approval page (Bug 3)', () => {
  // onShowRecover must route desktop to the sign-in screen.
  assert.ok(
    WEB_UI.includes('if (isDesktop()) { onShowDesktopLogin(); return }'),
    'desktop recover must route to the sign-in screen',
  )
  assert.ok(WEB_UI.includes('function onShowDesktopLogin('), 'the desktop sign-in screen must exist')
  assert.ok(
    WEB_UI.includes('window.tesseraDesktop.loginStart('),
    'desktop sign-in must request a magic link via the bridge',
  )
  assert.ok(
    WEB_UI.includes('window.tesseraDesktop.loginVerify('),
    'desktop sign-in must verify + recover via the bridge',
  )
  // The dead-end approval-link path is gone for good.
  assert.ok(!WEB_UI.includes('onRecoverContinueDesktop('), 'the approval-link recovery must be gone')
  assert.ok(!WEB_UI.includes('recoverApprovalStep'), 'the approval step must be gone')
  assert.ok(!WEB_UI.includes('beginRecovery('), 'web-ui must not use the approval-link recovery')
  assert.ok(!WEB_UI.includes('completeRecovery('), 'web-ui must not use the approval-link recovery')
})

test('Bug 6: Forget this device clears the shared desktop config', () => {
  const start = WEB_UI.indexOf('async function onRemoveBrowser()')
  assert.ok(start !== -1)
  const fn = WEB_UI.slice(start, start + 3000)
  assert.ok(fn.includes('window.tesseraDesktop.forget()'), 'desktop forget must clear the shared config')
  assert.ok(fn.includes('this device'), 'desktop confirm copy must say "this device"')
})

test('the dead direct-recovery attempt is gone', () => {
  assert.ok(!AUTH.includes('Direct recovery failed'), 'the old fallback warning must be gone')
  assert.ok(!AUTH.includes('Try direct recovery first'), 'the old comment must be gone')
  assert.ok(
    AUTH.includes('fetchRecoveryCredential') && AUTH.includes('recoverWithConnectKey'),
    'auth.js must own the session-backed recovery',
  )
})
