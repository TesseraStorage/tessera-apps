// @tessera/shared — one-time handoff consumption + linking state machine
// (P6 Task 2, Decision 2).
//
// Tessera-FE mints a one-time, 300 s handoff code and redirects the browser
// to `/web/#handoff=<code>` — fragment transport, so the code never reaches
// nginx/moneyd access logs. This module owns everything that happens after
// that redirect:
//
//   - reading the code out of the fragment (and the legacy `?handoff=`
//     query → fragment remap the web shell runs before the app boots);
//   - `POST /api/v1/handoff/consume` (unauthenticated by design; the code
//     itself is the credential) with 200/409/410 mapped to link states;
//   - a same-tab `sessionStorage` marker `{stage, connectKey}` written the
//     instant a consume succeeds, so a reload resumes registration from the
//     already-returned connect key instead of consuming the one-time code
//     again (re-consume would answer a false 410 "invalid_code");
//   - explicit device-replacement confirmation when this browser already
//     holds an identity;
//   - best-effort `POST /api/v1/credentials/activate` after registration
//     (401/403/404 → "linking now, refresh shortly"; the scheduler tick
//     links it later; 409 → already-linked no-op).
//
// SECRETS (Decision 2d): the handoff CODE is never persisted and never
// logged. It lives in this closure/`currentCode` only, is sent exactly once
// in the consume POST body (never a URL/query), and is dropped as soon as
// the consume succeeds. Only the returned `connectKey` reaches the marker,
// which is cleared once registration/activation completes. Every diagnostic
// line this module emits goes through `redactHandoffCode()` as
// defense-in-depth. The legacy `?handoff=` initial HTTP request is
// loggable by design (plan ruling); the guarantee is scoped to the
// fragment path this app actually uses.

export const HANDOFF_MARKER_KEY = 'tesseraweb.handoff'

export const MARKER_STAGES = {
  // Code consumed, connectKey held; registration not yet complete.
  CONSUMED: 'consumed',
  // Registration complete; activate is pending/best-effort.
  REGISTERED: 'registered',
}

export const HANDOFF_STATES = {
  IDLE: 'idle',
  CONFIRM_REPLACE: 'confirm_replace',
  CONSUMING: 'consuming',
  CONSUMED: 'consumed',
  RESUMING: 'resuming',
  RESUMED: 'resumed',
  RECOVERY: 'recovery',           // 409 with no local identity
  ALREADY_LINKED: 'already_linked', // 409 with a local identity / activate 409
  LINK_EXPIRED: 'link_expired',   // 410
  ACTIVATING: 'activating',
  LINKED: 'linked',
  LINKING_PENDING: 'linking_pending',
  CANCELLED: 'cancelled',
  ERROR: 'error',
}

export const HANDOFF_PENDING_MESSAGE = 'Linking now, refresh shortly.'

const CONSUME_PATH = '/api/v1/handoff/consume'
const ACTIVATE_PATH = '/api/v1/credentials/activate'

function joinUrl(base, path) {
  return (base ? String(base).replace(/\/+$/, '') : '') + path
}

// `#handoff=<code>` is the only fragment this app treats as a code. Screen
// hashes (`#files`, `#setPassword`, `#files/Photos`) and `#handoff` with no
// value all return null.
export function extractHandoffCode(hash) {
  if (!hash || typeof hash !== 'string') return null
  const raw = hash.charAt(0) === '#' ? hash.slice(1) : hash
  if (!raw || raw.indexOf('handoff=') === -1) return null
  let value = null
  try {
    value = new URLSearchParams(raw).get('handoff')
  } catch (_) {
    return null
  }
  return value || null
}

// LEGACY `?handoff=<code>` → `#handoff=<code>` (spec §6.3 divergence).
// Runs as the web shell's first module script — before mountApp() — so the
// code leaves the query string immediately: no later same-origin request,
// Referer, or diary `url=` line can carry it. The initial HTTP request that
// already happened did carry the query and is loggable by design (plan
// ruling); from this call on the code is fragment-only. Other query
// parameters are preserved. Returns the code, or null when there was
// nothing to remap.
export function mapLegacyHandoffToFragment(win) {
  if (!win || !win.location || !win.history) return null
  const loc = win.location
  const search = typeof loc.search === 'string' ? loc.search : ''
  if (!search || search.length < 2) return null
  let params
  try {
    params = new URLSearchParams(search)
  } catch (_) {
    return null
  }
  const code = params.get('handoff')
  if (!code) return null
  params.delete('handoff')
  const rest = params.toString()
  const url = (loc.pathname || '/') + (rest ? '?' + rest : '') + '#handoff=' + encodeURIComponent(code)
  try {
    win.history.replaceState(win.history.state, '', url)
  } catch (_) {
    return null
  }
  return code
}

// Remove a `#handoff=<code>` fragment from the current history entry (the
// code stays in memory only). No-op when the fragment is not a handoff.
export function scrubHandoffFragment(win) {
  if (!win || !win.location || !win.history) return false
  if (!extractHandoffCode(win.location.hash)) return false
  const url = (win.location.pathname || '/') + (win.location.search || '')
  try {
    win.history.replaceState(win.history.state, '', url)
  } catch (_) {
    return false
  }
  return true
}

// Replace any occurrence of the live handoff code in a diagnostic string.
// Never let a console/diary line carry the code, even if some future caller
// interpolates an error that happens to contain it.
export function redactHandoffCode(text, code) {
  const s = text == null ? '' : String(text)
  if (!code) return s
  return s.split(String(code)).join('[handoff-code]')
}

// ── same-tab resume marker (sessionStorage) ──────────────
//
// `{stage, connectKey}` only — the code is NEVER written here. sessionStorage
// (not localStorage) because the marker is meaningful only to this tab's
// in-flight linking flow: a new tab starts clean and may consume its own
// fresh code. Shape is validated on read so a corrupt value degrades to
// "no marker" instead of throwing.

export function readHandoffMarker(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null
  let parsed
  try {
    const raw = storage.getItem(HANDOFF_MARKER_KEY)
    if (!raw) return null
    parsed = JSON.parse(raw)
  } catch (_) {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (typeof parsed.connectKey !== 'string' || !parsed.connectKey) return null
  if (parsed.stage !== MARKER_STAGES.CONSUMED && parsed.stage !== MARKER_STAGES.REGISTERED) return null
  return { stage: parsed.stage, connectKey: parsed.connectKey }
}

export function writeHandoffMarker(storage, marker) {
  if (!storage || typeof storage.setItem !== 'function') return
  if (!marker || typeof marker.connectKey !== 'string' || !marker.connectKey) return
  if (marker.stage !== MARKER_STAGES.CONSUMED && marker.stage !== MARKER_STAGES.REGISTERED) return
  try {
    storage.setItem(HANDOFF_MARKER_KEY, JSON.stringify({ stage: marker.stage, connectKey: marker.connectKey }))
  } catch (_) {}
}

export function clearHandoffMarker(storage) {
  if (!storage || typeof storage.removeItem !== 'function') return
  try {
    storage.removeItem(HANDOFF_MARKER_KEY)
  } catch (_) {}
}

// ── network calls ────────────────────────────────────────

// POST /api/v1/handoff/consume — unauthenticated; the one-time code IS the
// credential. The code travels in the JSON body, never the URL, so even a
// same-origin access log line for this request carries no secret.
// Returns {status, connectKey?, quota?, error?} for every HTTP outcome;
// only a transport failure rejects (the state machine maps that to ERROR).
export async function consumeHandoffCode(code, opts = {}) {
  const fetchFn = opts.fetchFn || ((...args) => globalThis.fetch(...args))
  const res = await fetchFn(joinUrl(opts.apiBase, CONSUME_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  let body = null
  try {
    body = await res.json()
  } catch (_) {}
  if (res.status === 200) {
    if (body && typeof body.connect_key === 'string' && body.connect_key) {
      return { status: 200, connectKey: body.connect_key, quota: body.quota }
    }
    return { status: 0, error: 'malformed_response' }
  }
  if (res.status === 409) return { status: 409, error: 'already_registered' }
  if (res.status === 410) return { status: 410, error: 'invalid_code' }
  const detailError = body && body.detail && body.detail.error
  return { status: res.status, error: detailError || 'unexpected' }
}

// POST /api/v1/credentials/activate — session/bearer; best-effort.
// Never throws: a transport failure reads as status 0 and the caller treats
// it exactly like a 401 (deferred to the scheduler tick).
export async function activateCredential(opts = {}) {
  const fetchFn = opts.fetchFn || ((...args) => globalThis.fetch(...args))
  try {
    const res = await fetchFn(joinUrl(opts.apiBase, ACTIVATE_PATH), { method: 'POST' })
    return { status: res.status }
  } catch (e) {
    return { status: 0, error: e && e.message }
  }
}

// ── state machine ────────────────────────────────────────
//
// deps:
//   fetchFn           injectable fetch (tests)
//   apiBase           prefix for /api/v1 (default '' = same origin)
//   storage           sessionStorage-like (default global sessionStorage)
//   hasLocalIdentity  () => bool — saved appId or wrapped vault on this device
//   resumeRegistration(connectKey, {resumed}) — headless connectWithInvite()
//                     + navigation to the password screen; may throw
//   onState(state, detail) — UI hook; every HANDOFF_STATES transition
//   log(line)         diagnostic sink; lines are code-redacted
//   scrubUrl()        remove #handoff=... from the address bar on success
export function createHandoffMachine(deps = {}) {
  const fetchFn = deps.fetchFn
  const apiBase = deps.apiBase || ''
  const storage = deps.storage !== undefined
    ? deps.storage
    : (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
  const hasLocalIdentity = deps.hasLocalIdentity || (() => false)
  const resumeRegistration = deps.resumeRegistration || (async () => {})
  const onState = deps.onState || (() => {})
  const log = deps.log || (() => {})
  const scrubUrl = deps.scrubUrl || (() => {})

  let state = HANDOFF_STATES.IDLE
  let detail = {}
  let currentCode = null      // in-memory ONLY; never persisted
  let currentKey = null       // connectKey, in-memory ONLY; redacted from logs too
  let replaceConfirmed = false

  function note(line) {
    try {
      let s = redactHandoffCode(line, currentCode)
      if (currentKey) s = s.split(String(currentKey)).join('[connect-key]')
      log(s)
    } catch (_) {}
  }

  function emit(next, extra) {
    state = next
    detail = extra || {}
    try {
      onState(state, detail)
    } catch (e) {
      note('onState failed: ' + (e && e.message))
    }
  }

  async function consume() {
    if (!currentCode) {
      emit(HANDOFF_STATES.ERROR, { phase: 'consume' })
      return
    }
    emit(HANDOFF_STATES.CONSUMING)
    let res
    try {
      res = await consumeHandoffCode(currentCode, { fetchFn, apiBase })
    } catch (e) {
      note('consume failed: ' + (e && e.message))
      emit(HANDOFF_STATES.ERROR, { phase: 'consume', transport: true })
      return
    }
    if (res.status === 200) {
      // Marker BEFORE resumeRegistration(): a reload any time after this
      // point must resume from the key, never re-consume.
      currentKey = res.connectKey
      writeHandoffMarker(storage, { stage: MARKER_STAGES.CONSUMED, connectKey: res.connectKey })
      replaceConfirmed = false
      currentCode = null
      scrubUrl()
      emit(HANDOFF_STATES.CONSUMED, { quota: res.quota })
      try {
        await resumeRegistration(res.connectKey, { resumed: false })
        emit(HANDOFF_STATES.RESUMED)
      } catch (e) {
        note('registration start failed: ' + (e && e.message))
        emit(HANDOFF_STATES.ERROR, { phase: 'registration' })
      }
      return
    }
    if (res.status === 409) {
      emit(hasLocalIdentity() ? HANDOFF_STATES.ALREADY_LINKED : HANDOFF_STATES.RECOVERY)
      return
    }
    if (res.status === 410) {
      emit(HANDOFF_STATES.LINK_EXPIRED)
      return
    }
    note('consume http status=' + res.status)
    emit(HANDOFF_STATES.ERROR, { phase: 'consume', httpStatus: res.status })
  }

  // Boot entry. A resume marker always wins over a fragment code (the
  // fragment may still be sitting in the URL from the consume redirect).
  async function start(opts = {}) {
    const code = opts.code || null
    const marker = readHandoffMarker(storage)
    if (marker) {
      currentCode = null
      currentKey = marker.connectKey
      replaceConfirmed = false
      if (marker.stage === MARKER_STAGES.REGISTERED) {
        return activate()
      }
      emit(HANDOFF_STATES.RESUMING, { resumed: true })
      try {
        await resumeRegistration(marker.connectKey, { resumed: true })
        emit(HANDOFF_STATES.RESUMED)
      } catch (e) {
        note('resume failed: ' + (e && e.message))
        emit(HANDOFF_STATES.ERROR, { phase: 'resume' })
      }
      return
    }
    if (!code) {
      emit(HANDOFF_STATES.IDLE)
      return
    }
    currentCode = String(code)
    if (hasLocalIdentity() && !replaceConfirmed) {
      emit(HANDOFF_STATES.CONFIRM_REPLACE)
      return
    }
    return consume()
  }

  function confirmReplace() {
    if (state !== HANDOFF_STATES.CONFIRM_REPLACE) return
    replaceConfirmed = true
    return consume()
  }

  function cancel() {
    currentCode = null
    replaceConfirmed = false
    emit(HANDOFF_STATES.CANCELLED)
  }

  function retry() {
    return start({ code: currentCode })
  }

  // Called once completeRegistration() has persisted the device key. Moves
  // the marker to `registered` (activate pending) and runs the best-effort
  // activate. No-op when this tab never consumed a handoff.
  async function noteRegistrationComplete() {
    const marker = readHandoffMarker(storage)
    if (!marker || marker.stage !== MARKER_STAGES.CONSUMED) return { outcome: 'none' }
    writeHandoffMarker(storage, { stage: MARKER_STAGES.REGISTERED, connectKey: marker.connectKey })
    return activate()
  }

  // Best-effort activate. 200 → linked; 409 → already-linked no-op;
  // 401/403/404 (and transport failures) → pending, scheduler tick links it.
  // The marker is cleared on every completed attempt — nothing about the
  // link needs the connectKey afterwards.
  async function activate() {
    const marker = readHandoffMarker(storage)
    if (!marker) {
      emit(HANDOFF_STATES.IDLE)
      return { outcome: 'none' }
    }
    if (marker.stage !== MARKER_STAGES.REGISTERED) {
      return { outcome: 'not_ready' }
    }
    emit(HANDOFF_STATES.ACTIVATING)
    let res
    try {
      res = await activateCredential({ fetchFn, apiBase })
    } catch (_) {
      res = { status: 0 }
    }
    clearHandoffMarker(storage)
    if (res.status === 200) {
      emit(HANDOFF_STATES.LINKED, { outcome: 'linked', message: 'This device is linked.' })
      return { outcome: 'linked', httpStatus: 200 }
    }
    if (res.status === 409) {
      emit(HANDOFF_STATES.ALREADY_LINKED, { outcome: 'already_linked', message: 'This device is already linked.' })
      return { outcome: 'already_linked', httpStatus: 409 }
    }
    emit(HANDOFF_STATES.LINKING_PENDING, {
      outcome: 'pending',
      message: HANDOFF_PENDING_MESSAGE,
      httpStatus: res.status,
    })
    return { outcome: 'pending', message: HANDOFF_PENDING_MESSAGE, httpStatus: res.status }
  }

  function snapshot() {
    return { state, detail }
  }

  return { start, confirmReplace, cancel, retry, noteRegistrationComplete, activate, snapshot }
}
