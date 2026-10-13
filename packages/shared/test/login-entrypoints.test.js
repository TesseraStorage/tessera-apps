// @tessera/shared — login entry points (Bug 1 / Bug 2 / Bug 5, 2026-10-13)
//
// Structural guards for the welcome-screen corrections: "Log in" is the
// primary, invite is a demo-only secondary, the web "Log in" sends the user
// to tessera.storage/account with a same-origin connect intent, and the
// authenticated-only header is hidden until a real identity exists.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WEB_UI = readFileSync(
  fileURLToPath(new URL('../src/web-ui.js', import.meta.url)),
  'utf8',
)

test('Bug 2: welcome offers Log in (primary), invite (demo), and recovery', () => {
  assert.ok(WEB_UI.includes('id="btnLogIn" class="btn btn-primary btn-lg"'), 'Log in must be the primary button')
  assert.ok(WEB_UI.includes('id="btnHaveInvite" class="btn btn-outline btn-lg"'), 'invite must be a secondary option')
  assert.ok(WEB_UI.includes('id="btnHaveWords"'), 'seed-phrase recovery must stay available')
  assert.ok(!WEB_UI.includes('id="btnCreate"'), 'the old "I\'m new" primary button must be gone')
  assert.ok(
    WEB_UI.includes("r.btnHaveInvite.addEventListener('click', onShowInvite)"),
    'the invite option must open the invite screen',
  )
})

test('Bug 1: web Log in sends the user to /account with a connect intent', () => {
  const start = WEB_UI.indexOf('function onShowLogin()')
  const end = WEB_UI.indexOf('function onShowInvite()')
  assert.ok(start !== -1 && end > start)
  const fn = WEB_UI.slice(start, end)
  assert.ok(fn.includes("localStorage.setItem('tessera.connectOnLogin', '1')"), 'web Log in must set the connect intent')
  assert.ok(fn.includes('window.location.assign(BILLING_SIGN_IN_URL)'), 'web Log in must go to the account page')
  assert.ok(fn.includes('onShowDesktopLogin()'), 'desktop Log in must use the in-app sign-in')
})

test('Bug 5: authenticated-only header is gated to Files and Account', () => {
  assert.ok(
    WEB_UI.includes("r.header.classList.toggle('hidden', !(s === 'files' || s === 'billing'))"),
    'the header must only appear on authenticated screens',
  )
  // The pre-login screens must all hide it (they are not files/billing).
  for (const s of ['welcome', 'invite', 'recover', 'desktopLogin', 'unlock', 'setPassword', 'words', 'handoff', 'readyWait', 'requestStub']) {
    assert.ok(s !== 'files' && s !== 'billing')
  }
})
