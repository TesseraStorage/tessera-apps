// STOCK DOOR ONLY (2026-09-30, "tessera-web-stock-face"). Imported solely behind
// `IS_STOCK` (door.js) so the T-SDK bundle drops this whole module.
//
// A PASSIVE tap on window.fetch: when the Foundation stock SDK itself GETs
// https://catalog.tessera.storage/hosts, clone() the response it already got and read the
// clone. This module NEVER issues a request of its own -- no second GET /hosts to decorate
// the debug diary, no Tessera plate, no occupy, no L3.
//
// Two consumers:
//   1. catalogGeo  -- publicKey -> {lat, lon} from the catalog HostInfo body (only if the body
//      carries latitude/longitude as numbers); the stock map's ONLY pin source.
//   2. armCatalogTray(cb) -- files.js arms this at Add-start; the next observed catalog
//      /hosts response is handed to cb once (the diary's "tray n=" line = the catalog list
//      the stock SDK fetched for that job).
export const CATALOG_HOST = 'catalog.tessera.storage'
export const catalogGeo = {}

let _armed = null

export function armCatalogTray(cb) { _armed = cb }
export function disarmCatalogTray() { _armed = null }

function listFrom(body) {
  if (Array.isArray(body)) return body
  if (body && Array.isArray(body.hosts)) return body.hosts
  return null
}

function onHostsBody(body) {
  const list = listFrom(body)
  if (list) {
    for (const h of list) {
      if (h && typeof h.publicKey === 'string' && typeof h.latitude === 'number' && typeof h.longitude === 'number') {
        const geo = { lat: h.latitude, lon: h.longitude }
        catalogGeo[h.publicKey] = geo
        catalogGeo[h.publicKey.replace(/^ed25519:/, '')] = geo
      }
    }
  }
  const cb = _armed
  if (cb) { _armed = null; try { cb(list) } catch (_) { /* diary only */ } }
}

export function installCatalogTap() {
  if (typeof window === 'undefined' || window.___tct___) return
  window.___tct___ = true
  const _f = window.fetch.bind(window)
  window.fetch = function (input, init) {
    const p = _f(input, init)
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase()
      if (method === 'GET' && url) {
        const u = new URL(url, window.location.href)
        if (u.hostname === CATALOG_HOST && u.pathname === '/hosts') {
          p.then((resp) => {
            if (resp && resp.ok) resp.clone().json().then(onHostsBody).catch(() => {})
          }).catch(() => {})
        }
      }
    } catch (_) { /* tap must never break the SDK's own request */ }
    return p
  }
}
