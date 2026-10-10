// DOOR FLAG (2026-09-30, "tessera-web-stock-face"): COMPILE-TIME, not runtime.
// Two doors are built from this one source tree:
//   't-sdk' -> https://tessera.storage/v2/tessera/web/    (apps/web,   Tessera T-SDK wasm, index.tessera.storage via /web/idx/)
//   'stock' -> https://tessera.storage/v2/tessera/stock/  (apps/stock, Foundation stock wasm, catalog.tessera.storage direct)
// Each app's vite.config.js `define`s __TESSERA_DOOR__ to a string literal, so every
// `IS_STOCK` branch below is dead-code-eliminated from the other door's bundle.
// There is deliberately NO runtime ?sdk= switch and no way for one bundle to load both wasms.
// (apps/desktop does not define it -> falls back to 't-sdk', its existing behavior.)
export const DOOR = (typeof __TESSERA_DOOR__ !== 'undefined') ? __TESSERA_DOOR__ : 't-sdk'
export const IS_STOCK = DOOR === 'stock'
