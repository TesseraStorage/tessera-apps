// Task 8 E2E — Node driver for the real packages/shared/src/handoff.js code.
//
// Modes:
//   happy    parse the fragment URL with extractHandoffCode, run the real
//            createHandoffMachine (consume -> register through /web/idx/ ->
//            best-effort activate), then re-consume the spent code.
//   consume  call consumeHandoffCode once and assert the expected status
//            (409 already_registered / 410 invalid_code refusals).
//
// Every diagnostic line goes to stdout and to TESSERA_E2E_DIARY. Handoff
// codes arrive through the environment, are never printed, and are only ever
// referenced by sha256 fingerprint in diagnostics.

import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  extractHandoffCode,
  consumeHandoffCode,
  createHandoffMachine,
} from '../../packages/shared/src/handoff.js'

const mode = process.argv[2] || 'consume'
const apiBase = process.env.TESSERA_E2E_API_BASE
const cookie = process.env.TESSERA_E2E_COOKIE || ''
const diaryPath = process.env.TESSERA_E2E_DIARY

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

function diary(line) {
  const text = String(line).replace(/\s+$/, '')
  if (diaryPath) appendFileSync(diaryPath, text + '\n')
  process.stdout.write(text + '\n')
}

function fail(label) {
  process.stdout.write(`FAIL ${label}\n`)
  process.exit(1)
}

function check(condition, label) {
  if (condition) diary(`PASS ${label}`)
  else fail(label)
}

function sameOriginFetch(url, init = {}) {
  const headers = { ...(init.headers || {}) }
  if (cookie) headers.Cookie = cookie
  if (apiBase) headers.Origin = apiBase
  return fetch(url, { ...init, headers })
}

function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  }
}

async function happy() {
  const fragmentUrl = new URL(process.env.TESSERA_E2E_FRAGMENT_URL)
  const expectedCode = process.env.TESSERA_E2E_EXPECTED_CODE

  const extracted = extractHandoffCode(fragmentUrl.hash)
  check(extracted === expectedCode, 'fragment-code-match')
  diary(`fragment_code_match=${extracted === expectedCode} code_sha256=${fingerprint(expectedCode)}`)
  check(!fragmentUrl.search.includes('handoff'), 'code-absent-from-query')
  diary('fragment_transport=fragment-only')

  const statuses = {}
  async function recordingFetch(url, init = {}) {
    const response = await sameOriginFetch(url, init)
    const path = new URL(url).pathname
    if (path.endsWith('/handoff/consume')) statuses.consume = response.status
    if (path.endsWith('/credentials/activate')) statuses.activate = response.status
    if (path.endsWith('/web/idx/register')) statuses.register = response.status
    return response
  }

  const states = []
  const machine = createHandoffMachine({
    fetchFn: recordingFetch,
    apiBase,
    storage: memoryStorage(),
    hasLocalIdentity: () => false,
    resumeRegistration: async (connectKey, info) => {
      const response = await recordingFetch(`${apiBase}/web/idx/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_key: connectKey }),
      })
      const payload = await response.json().catch(() => null)
      diary(`resume_registration resumed=${!!(info && info.resumed)} register_status=${response.status} account_present=${!!(payload && payload.ok)}`)
      if (response.status !== 200) throw new Error('registration failed')
    },
    onState: (state) => {
      states.push(state)
      diary(`machine_state=${state}`)
    },
    log: (line) => diary(`machine_log=${line}`),
    scrubUrl: () => diary('fragment_scrubbed=true'),
  })

  await machine.start({ code: extracted })
  check(statuses.consume === 200, 'consume-status-200')
  diary(`consume_status=${statuses.consume}`)
  check(statuses.register === 200, 'register-status-200')
  diary(`register_status=${statuses.register}`)
  check(machine.snapshot().state === 'resumed', 'machine-state-resumed')

  const completion = await machine.noteRegistrationComplete()
  check(completion.outcome === 'linked', 'activate-outcome-linked')
  diary(`activate_outcome=${completion.outcome} activate_status=${statuses.activate}`)

  const again = await consumeHandoffCode(extracted, {
    fetchFn: sameOriginFetch,
    apiBase,
  })
  check(again.status === 410, 'reconsume-status-410')
  diary(`reconsume_status=${again.status} reconsume_error=${again.error}`)

  diary('happy=ok')
}

async function consume() {
  const code = process.env.TESSERA_E2E_CODE
  const expected = Number(process.env.TESSERA_E2E_EXPECTED_STATUS)
  const result = await consumeHandoffCode(code, {
    fetchFn: sameOriginFetch,
    apiBase,
  })
  diary(`consume_status=${result.status} consume_error=${result.error || ''}`)
  check(result.status === expected, `consume-status-${expected}`)
  diary('consume=ok')
}

try {
  if (mode === 'happy') await happy()
  else await consume()
} catch (error) {
  fail(`driver-error phase=${mode}`)
}
