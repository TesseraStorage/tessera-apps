// @tessera/shared — SDK wrapper
import {
  initSia as initWasm,
  Builder, AppKey, PinnedObject,
  generateRecoveryPhrase, validateRecoveryPhrase,
} from '../vendor/sia-storage/dist/index.js'
import { installFetchInterceptor, installWebTransportShim, registerSdk } from './interceptor.js'

let _ready = false
export async function initSia(fetchMode) {
  if (_ready) return
  installWebTransportShim()    // must install BEFORE initWasm — WebTransport is called during WASM init
  installFetchInterceptor(fetchMode)
  await initWasm()
  _ready = true
}
export { Builder, AppKey, PinnedObject, generateRecoveryPhrase, validateRecoveryPhrase, registerSdk }

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