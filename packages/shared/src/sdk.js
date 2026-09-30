// @tessera/shared — SDK wrapper
import {
  initSia as initWasm,
  Builder, AppKey, PinnedObject,
  generateRecoveryPhrase, validateRecoveryPhrase,
  encodedSize,
} from '../vendor/sia-storage/dist/index.js'
import { installFetchInterceptor, installWebTransportShim, registerSdk } from './interceptor.js'
import { IS_STOCK } from './door.js'
import { installCatalogTap } from './stock-catalog.js'

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
  // STOCK DOOR (2026-09-30): native WebTransport too -- never shimmed, no /__tunnel__.
  if (IS_STOCK) installCatalogTap()   // passive read of the SDK's own /hosts response (stock-catalog.js)
  if (fetchMode !== 'idx' && !IS_STOCK) installWebTransportShim()    // must install BEFORE initWasm — WebTransport is called during WASM init
  installFetchInterceptor(fetchMode)
  await initWasm()
  _ready = true
}
export { Builder, AppKey, PinnedObject, generateRecoveryPhrase, validateRecoveryPhrase, registerSdk, encodedSize }

// INDEXER BASE (2026-09-14, "tessera-web-v1"): Drop's fetch interceptor
// (interceptor.js) rewrites any request whose URL contains the literal
// host 'index.tessera.storage' to go through this same origin's own /idx/
// proxy path -- so the indexer "URL" the SDK is configured with only
// needs to resolve to something containing that hostname; it never
// actually leaves the browser as a direct cross-origin request. Both
// apps (Drop at /v2/tessera/drop/, Tessera Web at /v2/tessera/web/) can
// keep using this exact same getIndexerUrl() unchanged -- each origin's
// own nginx location block (drop's /idx/ vs web's /idx/) does the actual
// routing, keyed off window.location.pathname at request time via
// proxyOrigin() in utils.js. No prefix parameter needed here.
// STOCK DOOR (2026-09-30, "tessera-web-stock-face"): the stock face aims the SDK straight at
// catalog.tessera.storage (nginx -> indexd :19982, no hostfilter, no plate, no occupy). The stock
// build sets fetch mode 'direct' (interceptor returns immediately), so this URL leaves the browser as-is
// (catalog answers Access-Control-Allow-Origin: *, verified). T-SDK build folds the ternary to index.
export function getIndexerUrl() { return IS_STOCK ? 'https://catalog.tessera.storage' : 'https://index.tessera.storage' }