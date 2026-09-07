// src/index.ts
import wasmInit from "../wasm/sia_storage_wasm.js";
import {
  AppKey,
  Builder,
  ObjectEvent,
  PackedUpload,
  PinnedObject,
  Sdk,
  encodedSize,
  generateRecoveryPhrase,
  setLogger,
  validateRecoveryPhrase
} from "../wasm/sia_storage_wasm.js";
var initPromise = null;
async function initSia() {
  if (!initPromise) initPromise = wasmInit();
  await initPromise;
}
export {
  AppKey,
  Builder,
  ObjectEvent,
  PackedUpload,
  PinnedObject,
  Sdk,
  encodedSize,
  generateRecoveryPhrase,
  initSia,
  setLogger,
  validateRecoveryPhrase
};
// sourcemap stripped