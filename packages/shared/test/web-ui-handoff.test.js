// @tessera/shared — web shell / web-ui handoff wiring (structural, P6 Task 2)
//
// The state machine itself is covered by handoff.test.js with injected
// fetch/storage. This file guards the parts that only exist once web-ui.js
// and the apps/web shell are in play: every handoff DOM id is declared and
// cached, the screen is toggled, the machine is wired, and the legacy
// ?handoff= remap is called before mountApp() in the shell script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WEB_UI = readFileSync(fileURLToPath(new URL('../src/web-ui.js', import.meta.url)), 'utf8')
const WEB_SHELL = readFileSync(fileURLToPath(new URL('../../../apps/web/index.html', import.meta.url)), 'utf8')

const HANDOFF_IDS = [
  'handoffScreen',
  'handoffTitle',
  'handoffBody',
  'btnHandoffPrimary',
  'btnHandoffCancel',
  'handoffStatus',
]

test('every handoff DOM id is declared in the skeleton and cached in cacheRefs', () => {
  const cacheBlock = WEB_UI.slice(
    WEB_UI.indexOf('function cacheRefs()'),
    WEB_UI.indexOf('for (const id of ids)'),
  )
  for (const id of HANDOFF_IDS) {
    assert.ok(cacheBlock.includes(`'${id}'`), `cacheRefs is missing '${id}'`)
    assert.ok(WEB_UI.includes(`id="${id}"`), `skeleton is missing id="${id}"`)
  }
})

test('handoffScreen is toggled with the other screens and header-hidden', () => {
  assert.ok(WEB_UI.includes("r.handoffScreen.classList.toggle('hidden', s !== 'handoff')"))
  // Bug 5: the header is authenticated-only chrome -- visible solely on Files
  // and Account, hidden on every pre-login screen (handoff included).
  assert.ok(
    WEB_UI.includes("r.header.classList.toggle('hidden', !(s === 'files' || s === 'billing'))"),
    'the header must be gated to authenticated screens (Bug 5)',
  )
})

test('handoff buttons are wired to the machine and states drive the screen', () => {
  assert.ok(WEB_UI.includes("r.btnHandoffPrimary.addEventListener('click', onHandoffPrimary)"))
  assert.ok(WEB_UI.includes("r.btnHandoffCancel.addEventListener('click', onHandoffCancel)"))
  assert.ok(WEB_UI.includes('function renderHandoffState('))
  assert.ok(WEB_UI.includes('handoffMachine.confirmReplace'))
  assert.ok(WEB_UI.includes('handoffMachine.retry'))
  assert.ok(WEB_UI.includes('handoffMachine.cancel()'))
})

test('boot prefers handoff before every other path, and registration completion is reported', () => {
  const boot = WEB_UI.indexOf('async function doBoot()')
  assert.ok(boot !== -1)
  assert.ok(WEB_UI.slice(boot).includes('if (await initHandoff()) return'), 'doBoot must hand off to initHandoff()')
  assert.ok(WEB_UI.includes('handoffMachine.noteRegistrationComplete()'), 'completeRegistration must report to the machine')
  assert.ok(WEB_UI.includes("log: line => console.warn('[tessera-web] handoff: ' + line)"))
})

test('web shell maps a legacy ?handoff= before mountApp in the same inline script', () => {
  const mapAt = WEB_SHELL.indexOf('mapLegacyHandoffToFragment(window)')
  const mountAt = WEB_SHELL.indexOf("mountApp('#app-root')")
  assert.ok(mapAt !== -1, 'shell must call mapLegacyHandoffToFragment(window)')
  assert.ok(mountAt !== -1, 'shell must call mountApp')
  assert.ok(mapAt < mountAt, 'the legacy query must be remapped before the app boots')
  assert.ok(WEB_SHELL.includes("from '@tessera/shared/handoff'"))
})
