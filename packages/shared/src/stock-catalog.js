// STOCK DOOR ONLY (2026-09-30, "tessera-web-stock-face"; REVISED 2026-10-01, "tessera-web-stock-arcs").
// Imported solely behind `IS_STOCK` (door.js) so the T-SDK bundle drops this whole module.
//
// A PASSIVE tap on window.fetch: when the Foundation stock SDK itself GETs
// https://catalog.tessera.storage/hosts, clone() the response it already got and read the
// clone. This module NEVER issues a request of its own -- no second GET /hosts to decorate
// the debug diary, no Tessera plate, no occupy, no L3.
//
// It REMEMBERS the latest /hosts body for this tab (unlock / page load / write all count), so
// an Add that does no /hosts fetch of its own can still print the catalog list and the map
// can still resolve pins for shards that land / download.
//   catalogGeo   -- publicKey -> {lat, lon} from the catalog HostInfo body (only when the body
//                   carries latitude/longitude as numbers); the stock map's ONLY pin source.
//   catalogState -- last list + counters, for the diary.
export const CATALOG_HOST = 'catalog.tessera.storage'
export const catalogGeo = {}

const state = { reqs: 0, okBodies: 0, lastStatus: '-', lastErr: '-', lastList: null, lastAt: 0 }
let _armed = null

export function catalogState() {
  return {
    reqs: state.reqs, okBodies: state.okBodies, lastStatus: state.lastStatus, lastErr: state.lastErr,
    list: state.lastList, ageMs: state.lastAt ? Date.now() - state.lastAt : null,
    geoN: Object.keys(catalogGeo).length / 2,
  }
}

// armCatalogTray(cb): cb(list, src) fires for the NEXT /hosts body the stock SDK fetches.
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
    state.lastList = list
    state.lastAt = Date.now()
    for (const h of list) {
      if (h && typeof h.publicKey === 'string' && typeof h.latitude === 'number' && typeof h.longitude === 'number') {
        const geo = { lat: h.latitude, lon: h.longitude }
        catalogGeo[h.publicKey] = geo
        catalogGeo[h.publicKey.replace(/^ed25519:/, '')] = geo
      }
    }
  } else {
    state.lastErr = 'shape'
  }
  const cb = _armed
  if (cb) { _armed = null; try { cb(list, 'catalog') } catch (_) { /* diary only */ } }
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
          state.reqs += 1
          p.then((resp) => {
            state.lastStatus = String(resp && resp.status)
            if (!resp || !resp.ok) return
            resp.clone().text().then((t) => {
              let body
              try { body = JSON.parse(t) } catch (e) { state.lastErr = 'json'; return }
              state.okBodies += 1
              onHostsBody(body)
            }).catch((e) => { state.lastErr = 'read' })
          }).catch(() => { state.lastErr = 'fetch' })
        }
      }
    } catch (_) { /* tap must never break the SDK's own request */ }
    return p
  }
}
