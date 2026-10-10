// @tessera/shared — handoff consumption + state machine tests (P6 Task 2)
//
// Node's built-in test runner, no browser needed: handoff.js is dependency-
// free and takes fetch/storage/session callbacks as injections.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  HANDOFF_MARKER_KEY, MARKER_STAGES, HANDOFF_STATES, HANDOFF_PENDING_MESSAGE,
  extractHandoffCode, mapLegacyHandoffToFragment, scrubHandoffFragment,
  redactHandoffCode, readHandoffMarker, writeHandoffMarker, clearHandoffMarker,
  consumeHandoffCode, activateCredential, createHandoffMachine,
} from '../src/handoff.js'

const SOURCE_PATH = fileURLToPath(new URL('../src/handoff.js', import.meta.url))

// ── harness ──────────────────────────────────────────────

function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(String(k), String(v)) },
    removeItem: (k) => { map.delete(k) },
    dump: () => Object.fromEntries(map),
  }
}

function fakeWindow({ pathname = '/web/', search = '', hash = '', state = null } = {}) {
  const loc = { pathname, search, hash }
  const win = { location: loc, replaceCalls: [] }
  win.history = {
    state,
    replaceState(nextState, _title, url) {
      win.replaceCalls.push({ state: nextState, url })
      win.history.state = nextState
      const u = new URL(url, 'https://index.tessera.storage')
      loc.pathname = u.pathname
      loc.search = u.search
      loc.hash = u.hash
    },
  }
  return win
}

function jsonRes(status, body) {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return body
    },
  }
}

function captureStates() {
  const states = []
  return { states, onState: (state, detail) => states.push({ state, detail }) }
}

function machineHarness({ responses = [], localIdentity = false, storage = fakeStorage(), marker = null } = {}) {
  if (marker) writeHandoffMarker(storage, marker)
  const fetchCalls = []
  const logs = []
  const resumes = []
  const scrubCalls = []
  const { states, onState } = captureStates()
  const fetchFn = async (url, init) => {
    fetchCalls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch: ' + url)
    if (typeof next === 'function') return next(url, init)
    return next
  }
  const machine = createHandoffMachine({
    fetchFn,
    apiBase: '',
    storage,
    hasLocalIdentity: () => localIdentity,
    resumeRegistration: async (connectKey, detail) => { resumes.push({ connectKey, ...detail }) },
    onState,
    log: (line) => logs.push(line),
    scrubUrl: () => scrubCalls.push(true),
  })
  return { machine, fetchCalls, logs, resumes, scrubCalls, states, storage }
}

function stateNames(states) {
  return states.map(s => s.state)
}

// ── consumeHandoffCode: 200 / 409 / 410 ──────────────────

test('consume 200 returns connectKey + quota; the code travels only in the POST body', async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return jsonRes(200, { connect_key: 'CONNECT-KEY-1', quota: '10 GB' })
  }
  const res = await consumeHandoffCode('SECRET-CODE-1', { fetchFn })
  assert.deepEqual(res, { status: 200, connectKey: 'CONNECT-KEY-1', quota: '10 GB' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/v1/handoff/consume')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: 'SECRET-CODE-1' })
  assert.ok(!calls[0].url.includes('SECRET-CODE-1'), 'code must never be in the URL')
})

test('consume 409 maps to already_registered', async () => {
  const res = await consumeHandoffCode('C', { fetchFn: async () => jsonRes(409, { detail: { error: 'already_registered' } }) })
  assert.deepEqual(res, { status: 409, error: 'already_registered' })
})

test('consume 410 maps to invalid_code', async () => {
  const res = await consumeHandoffCode('C', { fetchFn: async () => jsonRes(410, { detail: { error: 'invalid_code' } }) })
  assert.deepEqual(res, { status: 410, error: 'invalid_code' })
})

test('consume 200 with a malformed body is an error, not a success', async () => {
  const res = await consumeHandoffCode('C', { fetchFn: async () => jsonRes(200, { nope: true }) })
  assert.equal(res.status, 0)
  assert.equal(res.error, 'malformed_response')
})

test('consume transport failure rejects (state machine maps it to ERROR)', async () => {
  await assert.rejects(
    () => consumeHandoffCode('C', { fetchFn: async () => { throw new Error('network down') } }),
    /network down/,
  )
})

test('consume apiBase is honored', async () => {
  const urls = []
  await consumeHandoffCode('C', { apiBase: 'https://api.example/', fetchFn: async (url) => { urls.push(url); return jsonRes(409, {}) } })
  assert.deepEqual(urls, ['https://api.example/api/v1/handoff/consume'])
})

// ── legacy ?handoff= → fragment mapping ──────────────────

test('mapLegacyHandoffToFragment moves ?handoff to the fragment and keeps other params', () => {
  const win = fakeWindow({ pathname: '/web/', search: '?handoff=CODE-9&debug=1' })
  const code = mapLegacyHandoffToFragment(win)
  assert.equal(code, 'CODE-9')
  assert.equal(win.location.search, '?debug=1')
  assert.equal(win.location.hash, '#handoff=CODE-9')
  assert.equal(win.replaceCalls.length, 1)
  const beforeHash = win.replaceCalls[0].url.split('#')[0]
  assert.ok(!beforeHash.includes('CODE-9'), 'query part must be code-free after mapping')
})

test('mapLegacyHandoffToFragment handles handoff as the only param and percent-encoded codes', () => {
  const only = fakeWindow({ pathname: '/web/', search: '?handoff=ABC' })
  assert.equal(mapLegacyHandoffToFragment(only), 'ABC')
  assert.equal(only.location.search, '')
  assert.equal(only.location.hash, '#handoff=ABC')

  const encoded = fakeWindow({ pathname: '/web/', search: '?handoff=a%2Bb%3Dc' })
  assert.equal(mapLegacyHandoffToFragment(encoded), 'a+b=c')
  assert.equal(encoded.location.hash, '#handoff=' + encodeURIComponent('a+b=c'))
})

test('mapLegacyHandoffToFragment is a no-op without a handoff query', () => {
  const none = fakeWindow({ pathname: '/web/', search: '?debug=1' })
  assert.equal(mapLegacyHandoffToFragment(none), null)
  assert.equal(none.replaceCalls.length, 0)

  const empty = fakeWindow({ pathname: '/web/', search: '?handoff=' })
  assert.equal(mapLegacyHandoffToFragment(empty), null)
  assert.equal(empty.replaceCalls.length, 0)

  const noWin = fakeWindow({ pathname: '/web/', search: '' })
  assert.equal(mapLegacyHandoffToFragment(noWin), null)
})

test('extractHandoffCode reads only #handoff=<code>', () => {
  assert.equal(extractHandoffCode('#handoff=XYZ'), 'XYZ')
  assert.equal(extractHandoffCode('handoff=XYZ'), 'XYZ')
  assert.equal(extractHandoffCode('#handoff=a%2Bb'), 'a+b')
  assert.equal(extractHandoffCode('#handoff='), null)
  assert.equal(extractHandoffCode('#handoff'), null)
  assert.equal(extractHandoffCode('#setPassword'), null)
  assert.equal(extractHandoffCode('#files/Photos'), null)
  assert.equal(extractHandoffCode(''), null)
  assert.equal(extractHandoffCode(null), null)
})

test('scrubHandoffFragment removes the code from the URL, no-op otherwise', () => {
  const win = fakeWindow({ pathname: '/web/', search: '', hash: '#handoff=SECRET' })
  assert.equal(scrubHandoffFragment(win), true)
  assert.equal(win.location.hash, '')
  assert.equal(win.replaceCalls.length, 1)
  assert.ok(!win.replaceCalls[0].url.includes('SECRET'))

  const clean = fakeWindow({ pathname: '/web/', search: '?debug=1', hash: '#files' })
  assert.equal(scrubHandoffFragment(clean), false)
  assert.equal(clean.replaceCalls.length, 0)
})

// ── marker ───────────────────────────────────────────────

test('marker round-trips {stage, connectKey}, validates shape, and never carries the code', () => {
  const storage = fakeStorage()
  writeHandoffMarker(storage, { stage: MARKER_STAGES.CONSUMED, connectKey: 'CK' })
  assert.deepEqual(readHandoffMarker(storage), { stage: 'consumed', connectKey: 'CK' })
  clearHandoffMarker(storage)
  assert.equal(readHandoffMarker(storage), null)

  storage.setItem(HANDOFF_MARKER_KEY, '{not json')
  assert.equal(readHandoffMarker(storage), null)
  storage.setItem(HANDOFF_MARKER_KEY, JSON.stringify({ stage: 'consumed' }))
  assert.equal(readHandoffMarker(storage), null)
  storage.setItem(HANDOFF_MARKER_KEY, JSON.stringify({ stage: 'bogus', connectKey: 'CK' }))
  assert.equal(readHandoffMarker(storage), null)
})

test('redactHandoffCode strips every occurrence', () => {
  assert.equal(redactHandoffCode('failed for CODE-1 at CODE-1', 'CODE-1'), 'failed for [handoff-code] at [handoff-code]')
  assert.equal(redactHandoffCode('nothing here', null), 'nothing here')
  assert.equal(redactHandoffCode(null, 'x'), '')
})

// ── state machine: 200 ───────────────────────────────────

test('200: consumes, marks CONSUMED with the connectKey, resumes registration from it', async () => {
  const h = machineHarness({ responses: [jsonRes(200, { connect_key: 'CONNECT-KEY-1', quota: '10 GB' })] })
  await h.machine.start({ code: 'SECRET-CODE-1' })

  assert.deepEqual(stateNames(h.states), ['consuming', 'consumed', 'resumed'])
  assert.deepEqual(readHandoffMarker(h.storage), { stage: 'consumed', connectKey: 'CONNECT-KEY-1' })
  assert.deepEqual(h.resumes, [{ connectKey: 'CONNECT-KEY-1', resumed: false }])
  assert.equal(h.fetchCalls.length, 1)
  assert.equal(h.scrubCalls.length, 1, 'the fragment is scrubbed on success')
  assert.deepEqual(h.machine.snapshot(), { state: 'resumed', detail: {} })
})

test('reload with a CONSUMED marker resumes from the key and never re-consumes (no false 410)', async () => {
  const h = machineHarness({ marker: { stage: MARKER_STAGES.CONSUMED, connectKey: 'OLD-KEY' } })
  await h.machine.start({ code: 'A-FRESH-CODE-STILL-IN-THE-FRAGMENT' })

  assert.equal(h.fetchCalls.length, 0, 'consume must not be called again')
  assert.deepEqual(h.resumes, [{ connectKey: 'OLD-KEY', resumed: true }])
  assert.deepEqual(stateNames(h.states), ['resuming', 'resumed'])
  assert.deepEqual(readHandoffMarker(h.storage), { stage: 'consumed', connectKey: 'OLD-KEY' })
})

test('reload with a REGISTERED marker activates best-effort and clears the marker', async () => {
  const h = machineHarness({
    marker: { stage: MARKER_STAGES.REGISTERED, connectKey: 'OLD-KEY' },
    responses: [jsonRes(200, { linked: true })],
  })
  await h.machine.start({})

  assert.equal(h.fetchCalls.length, 1)
  assert.equal(h.fetchCalls[0].url, '/api/v1/credentials/activate')
  assert.equal(readHandoffMarker(h.storage), null)
  assert.deepEqual(stateNames(h.states), ['activating', 'linked'])
})

// ── state machine: device replacement confirmation ───────

test('saved identity: requires confirm_replace before consuming', async () => {
  const h = machineHarness({
    localIdentity: true,
    responses: [jsonRes(200, { connect_key: 'CK', quota: '1 GB' })],
  })
  await h.machine.start({ code: 'CODE-R' })

  assert.deepEqual(stateNames(h.states), ['confirm_replace'])
  assert.equal(h.fetchCalls.length, 0, 'nothing is consumed before the human confirms')

  await h.machine.confirmReplace()
  assert.deepEqual(stateNames(h.states), ['confirm_replace', 'consuming', 'consumed', 'resumed'])
  assert.deepEqual(readHandoffMarker(h.storage), { stage: 'consumed', connectKey: 'CK' })
})

test('cancel on the replace prompt drops the code and consumes nothing', async () => {
  const h = machineHarness({ localIdentity: true })
  await h.machine.start({ code: 'CODE-R' })
  h.machine.cancel()
  assert.deepEqual(stateNames(h.states), ['confirm_replace', 'cancelled'])
  assert.equal(h.fetchCalls.length, 0)
  assert.equal(readHandoffMarker(h.storage), null)
})

// ── state machine: 409 / 410 ─────────────────────────────

test('409 with no local identity maps to the recovery screen state', async () => {
  const h = machineHarness({ responses: [jsonRes(409, { detail: { error: 'already_registered' } })] })
  await h.machine.start({ code: 'CODE-409' })
  assert.deepEqual(stateNames(h.states), ['consuming', 'recovery'])
  assert.equal(readHandoffMarker(h.storage), null, 'no marker on 409')
})

test('409 with a local identity maps to already-linked (no recovery screen)', async () => {
  const h = machineHarness({
    localIdentity: true,
    responses: [jsonRes(409, { detail: { error: 'already_registered' } })],
  })
  await h.machine.start({ code: 'CODE-409' })
  await h.machine.confirmReplace()
  assert.deepEqual(stateNames(h.states), ['confirm_replace', 'consuming', 'already_linked'])
  assert.equal(readHandoffMarker(h.storage), null)
})

test('410 maps to the link-expired state (FE re-mint is Task 5)', async () => {
  const h = machineHarness({ responses: [jsonRes(410, { detail: { error: 'invalid_code' } })] })
  await h.machine.start({ code: 'CODE-410' })
  assert.deepEqual(stateNames(h.states), ['consuming', 'link_expired'])
  assert.equal(readHandoffMarker(h.storage), null)
})

test('consume transport/HTTP errors surface as ERROR and retry re-attempts', async () => {
  const h = machineHarness({
    responses: [async () => { throw new Error('offline') }, jsonRes(200, { connect_key: 'CK-2' })],
  })
  await h.machine.start({ code: 'CODE-E' })
  assert.deepEqual(stateNames(h.states), ['consuming', 'error'])
  assert.equal(h.states[1].detail.phase, 'consume')

  await h.machine.retry()
  assert.deepEqual(stateNames(h.states), ['consuming', 'error', 'consuming', 'consumed', 'resumed'])
  assert.deepEqual(readHandoffMarker(h.storage), { stage: 'consumed', connectKey: 'CK-2' })
})

test('registration start failure keeps the marker so a reload retries the resume', async () => {
  const storage = fakeStorage()
  const { states, onState } = captureStates()
  const machine = createHandoffMachine({
    fetchFn: async () => jsonRes(200, { connect_key: 'CK-3' }),
    storage,
    hasLocalIdentity: () => false,
    resumeRegistration: async () => { throw new Error('indexer down') },
    onState,
    log: () => {},
  })
  await machine.start({ code: 'CODE-F' })
  assert.deepEqual(stateNames(states), ['consuming', 'consumed', 'error'])
  assert.deepEqual(readHandoffMarker(storage), { stage: 'consumed', connectKey: 'CK-3' })
})

// ── state machine: best-effort activate ──────────────────

test('noteRegistrationComplete moves the marker to registered, then activate clears it on 200', async () => {
  const h = machineHarness({
    responses: [jsonRes(200, { linked: true })],
  })
  writeHandoffMarker(h.storage, { stage: MARKER_STAGES.CONSUMED, connectKey: 'CK-ACT' })
  const res = await h.machine.noteRegistrationComplete()

  assert.deepEqual(res, { outcome: 'linked', httpStatus: 200 })
  assert.equal(h.fetchCalls[0].url, '/api/v1/credentials/activate')
  assert.equal(readHandoffMarker(h.storage), null)
})

test('activate 409 is an already-linked no-op', async () => {
  const h = machineHarness({ responses: [jsonRes(409, { detail: { error: 'already_registered' } })] })
  writeHandoffMarker(h.storage, { stage: MARKER_STAGES.REGISTERED, connectKey: 'CK' })
  const res = await h.machine.activate()
  assert.equal(res.outcome, 'already_linked')
  assert.deepEqual(stateNames(h.states), ['activating', 'already_linked'])
  assert.equal(readHandoffMarker(h.storage), null)
})

for (const status of [401, 403, 404]) {
  test(`activate ${status} is best-effort: "linking now, refresh shortly", marker cleared`, async () => {
    const h = machineHarness({ responses: [jsonRes(status, {})] })
    writeHandoffMarker(h.storage, { stage: MARKER_STAGES.REGISTERED, connectKey: 'CK' })
    const res = await h.machine.activate()
    assert.equal(res.outcome, 'pending')
    assert.equal(res.message, HANDOFF_PENDING_MESSAGE)
    assert.deepEqual(stateNames(h.states), ['activating', 'linking_pending'])
    assert.equal(h.states[1].detail.message, 'Linking now, refresh shortly.')
    assert.equal(readHandoffMarker(h.storage), null)
  })
}

test('activate transport failure is also deferred to the scheduler tick', async () => {
  const h = machineHarness({ responses: [async () => { throw new Error('offline') }] })
  writeHandoffMarker(h.storage, { stage: MARKER_STAGES.REGISTERED, connectKey: 'CK' })
  const res = await h.machine.activate()
  assert.equal(res.outcome, 'pending')
  assert.equal(readHandoffMarker(h.storage), null)
})

test('activate before registration is complete is not ready and keeps the marker', async () => {
  const h = machineHarness({})
  writeHandoffMarker(h.storage, { stage: MARKER_STAGES.CONSUMED, connectKey: 'CK' })
  const res = await h.machine.activate()
  assert.deepEqual(res, { outcome: 'not_ready' })
  assert.equal(h.fetchCalls.length, 0)
  assert.deepEqual(readHandoffMarker(h.storage), { stage: 'consumed', connectKey: 'CK' })
})

test('noteRegistrationComplete is a no-op outside the handoff flow', async () => {
  const h = machineHarness({})
  const res = await h.machine.noteRegistrationComplete()
  assert.deepEqual(res, { outcome: 'none' })
  assert.equal(h.fetchCalls.length, 0)
})

// ── secrets: code absent from logs, diary, storage, state ─

test('the handoff code never reaches logs, diary, storage, URLs, or state details', async () => {
  const CODE = 'SECRET-HANDOFF-CODE-37'
  const scenarios = [
    { res: jsonRes(200, { connect_key: 'CK', quota: '1 GB' }), localIdentity: false },
    { res: jsonRes(409, {}), localIdentity: false },
    { res: jsonRes(409, {}), localIdentity: true },
    { res: jsonRes(410, {}), localIdentity: false },
    { res: async () => { throw new Error('offline') }, localIdentity: false },
  ]

  for (const scenario of scenarios) {
    const storage = fakeStorage()
    const consoleLines = []
    const originals = {}
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
      originals[m] = console[m]
      console[m] = (...args) => consoleLines.push(args.map(a => String(a)).join(' '))
    }
    // Simulated debug diary: files.js's diaryPush() writes console/pane
    // lines; nothing in the handoff module may ever touch it.
    const diary = []
    try {
      const machine = createHandoffMachine({
        fetchFn: async (url, init) => {
          assert.ok(!url.includes(CODE), 'code must never appear in a URL')
          if (init && init.body) {
            assert.ok(init.body.includes(CODE), 'the one place the code lives is the consume body')
          }
          return typeof scenario.res === 'function' ? scenario.res(url, init) : scenario.res
        },
        storage,
        hasLocalIdentity: () => scenario.localIdentity,
        resumeRegistration: async () => {},
        onState: (state, detail) => diary.push('state=' + state + ' ' + JSON.stringify(detail || {})),
      })
      await machine.start({ code: CODE })
      if (scenario.localIdentity) await machine.confirmReplace()
    } finally {
      for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = originals[m]
    }

    const surfaces = [
      ...consoleLines,
      ...diary,
      JSON.stringify(storage.dump()),
    ].join('\n')
    assert.ok(!surfaces.includes(CODE), 'code leaked into a log/diary/storage surface: ' + surfaces)
  }
})

test('resume diagnostics redact the connectKey even if an error echoes it', async () => {
  const logs = []
  const storage = fakeStorage()
  writeHandoffMarker(storage, { stage: MARKER_STAGES.CONSUMED, connectKey: 'CONNECT-KEY-SECRET' })
  const machine = createHandoffMachine({
    storage,
    hasLocalIdentity: () => false,
    resumeRegistration: async () => { throw new Error('failed for CONNECT-KEY-SECRET') },
    onState: () => {},
    log: (line) => logs.push(line),
  })
  await machine.start({})
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('[connect-key]'), 'connectKey is redacted')
  assert.ok(!logs[0].includes('CONNECT-KEY-SECRET'))
})

test('static guarantee: handoff.js has no console, diaryPush, or localStorage calls', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8')
  assert.ok(!/console\s*\./.test(src), 'handoff.js must not write to the console')
  assert.ok(!/diaryPush\s*\(/.test(src), 'handoff.js must not write diary lines')
  assert.ok(!/localStorage\s*\./.test(src), 'handoff.js must not touch localStorage')
  assert.ok(!/sessionStorage\s*\./.test(src), 'handoff.js must only use the injected storage handle')
})
