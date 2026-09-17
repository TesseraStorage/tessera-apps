// @tessera/shared — SDK wrapper
import {
  initSia as initWasm,
  Builder, AppKey, PinnedObject,
  generateRecoveryPhrase, validateRecoveryPhrase,
  encodedSize,
} from '../vendor/sia-storage/dist/index.js'
import { installFetchInterceptor, installWebTransportShim, registerSdk } from './interceptor.js'

let _ready = false
export async function initSia(fetchMode) {
  if (_ready) return
  // GATE (2026-09-14, "tessera-web-native-wt"): "Tessera Web must not shim
  // WebTransport. new WebTransport(...) is the browser's. No rewrite to
  // /__tunnel__." fetchMode === 'idx' is already Tessera Web's unique,
  // exclusive signal (Drop never passes it -- every Drop call site below
  // calls initSia() with no argument or a non-'idx' mode). Reusing it here
  // instead of adding a new parameter keeps every call site
  // (beginConnection/reconnectWithAppKey/beginRecovery/etc in auth.js)
  // unchanged and keeps Drop's default (shimmed, tunnel-based) behavior
  // byte-for-byte identical -- only Web's initSia('idx') call skips the
  // shim install.
  if (fetchMode !== 'idx') installWebTransportShim()    // must install BEFORE initWasm — WebTransport is called during WASM init
  installFetchInterceptor(fetchMode)
  await initWasm()
  _ready = true
}
export { Builder, AppKey, PinnedObject, generateRecoveryPhrase, validateRecoveryPhrase, registerSdk, encodedSize }

// INDEXER BASE (2026-09-14, "tessera-web-v1"): Drop's fetch interceptor
// (interceptor.js) rewrites any request whose URL contains the literal
// host 'index.dithr.dev' to go through this same origin's own /idx/
// proxy path -- so the indexer "URL" the SDK is configured with only
// needs to resolve to something containing that hostname; it never
// actually leaves the browser as a direct cross-origin request. Both
// apps (Drop at /v2/tessera/drop/, Tessera Web at /v2/tessera/web/) can
// keep using this exact same getIndexerUrl() unchanged -- each origin's
// own nginx location block (drop's /idx/ vs web's /idx/) does the actual
// routing, keyed off window.location.pathname at request time via
// proxyOrigin() in utils.js. No prefix parameter needed here.
export function getIndexerUrl() { return 'https://index.dithr.dev' }