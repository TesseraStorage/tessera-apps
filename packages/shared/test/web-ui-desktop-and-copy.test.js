// @tessera/shared — desktop sign-in + invite copy (2026-10-13 follow-up packet)
//
// Structural guards for:
//   item 2: desktop sign-in offers a real "create a new account" path (not a
//           dead-end token/12-words prompt) and accepts a pasted link;
//   item 5: the "no invite code" copy points at info@tessera.storage and the
//           old "ask the person who sent you here" sentence is gone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WEB_UI = readFileSync(
  fileURLToPath(new URL('../src/web-ui.js', import.meta.url)),
  'utf8',
)

test('item 5: the invite-request copy matches Tessera-FE', () => {
  assert.ok(
    WEB_UI.includes('Email info@tessera.storage for a time-boxed demo account.'),
    'the request stub must point at info@tessera.storage',
  )
  assert.ok(
    !WEB_UI.includes('Ask the person who sent you here.'),
    'the old "ask the person who sent you here" copy must be gone',
  )
})

test('item 2: desktop sign-in has a real create-account path', () => {
  assert.ok(WEB_UI.includes('id="btnDesktopCreate"'), 'the create-account button must exist')
  assert.ok(WEB_UI.includes('btnDesktopCreate') && WEB_UI.includes('onDesktopCreate'), 'it must be wired')
  assert.ok(
    WEB_UI.includes('generateRecoveryPhrase()'),
    'creating a new account must generate a fresh 12-word phrase',
  )
  assert.ok(
    WEB_UI.includes('paste the whole link'),
    'the UI must tell the user to paste the whole link',
  )
  assert.ok(
    WEB_UI.includes('I\u2019m new') || WEB_UI.includes("I&rsquo;m new"),
    'the new-user option must be clearly labelled',
  )
})

test('item 3: a spent-key registration error is explained, not raw', () => {
  assert.ok(WEB_UI.includes('function explainRegisterError('), 'the mapper must exist')
  assert.ok(WEB_UI.includes('no remaining uses'), 'it must detect the exhausted-key error')
  assert.ok(
    WEB_UI.includes('explainRegisterError(e.message') || WEB_UI.includes('explainRegisterError(e.message ||'),
    'the set-password / invite / recover errors must use the mapper',
  )
})
