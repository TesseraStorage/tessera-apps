// @tessera/shared — SDK wrapper
import {
  initSia as initWasm,
  Builder, AppKey, PinnedObject,
  generateRecoveryPhrase, validateRecoveryPhrase,
} from '../vendor/sia-storage/dist/index.js'
import { installFetchInterceptor, installWebTransportShim, registerSdk } from './interceptor.js'

let _ready = false
export async function initSia() {
  if (_ready) return
  installWebTransportShim()    // must install BEFORE initWasm — WebTransport is called during WASM init
  installFetchInterceptor()
  await initWasm()
  _ready = true
}
export { Builder, AppKey, PinnedObject, generateRecoveryPhrase, validateRecoveryPhrase, registerSdk }
export function getIndexerUrl() { return 'https://index.dithr.dev' }