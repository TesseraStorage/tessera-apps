// @tessera/shared — reactive store

/**
 * Tiny reactive store.  Components subscribe to state changes
 * and the store calls listeners whenever a key changes.
 */

const listeners = new Map()    // key → Set<function>
let state = {
  // App lifecycle
  screen: 'loading',           // loading | connect | phrase | main

  // Connection
  sdk: null,
  accountReady: false,

  // Registration
  builder: null,
  appId: '',
  phrase: '',

  // Files
  files: [],
  selectedIdx: -1,
  totals: { count: 0, totalBytes: 0 },

  // Busy / status
  busy: false,
  status: '',
  toast: '',

  // Progress (upload)
  progress: null,              // { stage, percent, elapsed } | null
}

// ── get / set ───────────────────────────────────────────

export function getState() {
  return state
}

export function patchState(patch) {
  const changed = []
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] !== v) {
      state[k] = v
      changed.push(k)
    }
  }
  if (changed.length === 0) return

  // Notify per-key listeners
  for (const key of changed) {
    const set = listeners.get(key)
    if (set) set.forEach(fn => fn(state[key], state))
  }

  // Notify wildcard listeners
  const all = listeners.get('*')
  if (all) all.forEach(fn => fn(changed, state))
}

// ── subscribe ───────────────────────────────────────────

/**
 * Subscribe to a specific key (or '*' for all changes).
 * Returns an unsubscribe function.
 */
export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key).add(fn)
  return () => listeners.get(key).delete(fn)
}

// ── computed helpers ────────────────────────────────────

export function selectedFile() {
  const { files, selectedIdx } = state
  if (selectedIdx < 0 || selectedIdx >= files.length) return null
  return files[selectedIdx]
}

// ── action helpers ──────────────────────────────────────

export function showToast(msg, duration = 4000) {
  patchState({ toast: msg })
  setTimeout(() => {
    if (state.toast === msg) patchState({ toast: '' })
  }, duration)
}

export function setBusy(b) {
  patchState({ busy: b })
}

export function setScreen(s) {
  patchState({ screen: s })
}