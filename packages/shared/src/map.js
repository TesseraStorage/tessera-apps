// @tessera/shared — Tessera Web upload map
//
// PACKET LAW (2026-09-14, "tessera-web-map-progress"): "hosts() occupies.
// Do not call hosts() / GET /hosts to feed the map. Use what the active
// upload already knows (shard callback fields, cached HostInfo from the
// SDK object already in memory)." This module never calls sdk.hosts()
// or any network endpoint for host selection -- it only reads:
//   1. hostKey off the onShardUploaded event (already flowing through
//      files.js -> web-ui.js's doUpload for the progress bar)
//   2. /v2/tessera/geo/geo.json -- a static, same-origin, already-existing
//      cache file (built by geo-collect.py from fleet.host_geo, same file
//      the Dataplane map view reads) for host_key -> {lat, lon}. This is
//      a data lookup, not a host-selection call -- it never occupies
//      anything, and it was already public/same-origin before this task.
//
// Look (packet's own words): "night land, Detroit origin, gold write /
// cyan read, city corridors not per-shard spaghetti." The named reference
// file (/home/workdir/artifacts/tessera-map/index.html) was not present
// on this box and no MAP2 source was found in this box's history or
// files -- built from the packet's own description instead: real land
// silhouettes (topojson via CDN, same data source the Dataplane globe
// view already uses in spirit -- not "neon-flat Google"), a dark/night
// background, and gold arcs from a Detroit-area origin point to each
// host that actually received a shard THIS upload (from the callback,
// never a fake world tour, never percent-as-mass).

const GEO_URL = '/v2/tessera/geo/geo.json'
const LAND_TOPOJSON_URL = 'https://unpkg.com/world-atlas@2/land-110m.json'
const TOPOJSON_CLIENT_URL = 'https://unpkg.com/topojson-client@3'

// Detroit, MI -- the packet's named origin point for write corridors.
const ORIGIN = { lat: 42.3314, lon: -83.0458 }

let _geoCache = null       // host_key -> {lat, lon}
let _landFeature = null    // GeoJSON FeatureCollection (land polygons)
let _loadPromise = null

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[data-tessera-map-src="' + src + '"]')) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.dataset.tesseraMapSrc = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load ' + src))
    document.head.appendChild(s)
  })
}

async function ensureAssets() {
  if (_loadPromise) return _loadPromise
  _loadPromise = (async () => {
    const [geoResp] = await Promise.all([
      fetch(GEO_URL).catch(() => null),
      loadScript(TOPOJSON_CLIENT_URL).catch(() => null),
    ])
    if (geoResp && geoResp.ok) {
      try {
        const geo = await geoResp.json()
        _geoCache = geo.hosts || {}
      } catch (_) { _geoCache = {} }
    } else {
      _geoCache = {}
    }
    try {
      const topoResp = await fetch(LAND_TOPOJSON_URL)
      const topo = await topoResp.json()
      if (window.topojson && window.topojson.feature) {
        _landFeature = window.topojson.feature(topo, topo.objects.land)
      }
    } catch (_) { _landFeature = null }
  })()
  return _loadPromise
}

// Simple equirectangular projection -- no d3-geo dependency needed for a
// flat lat/lon -> x/y map. lon in [-180,180] -> x in [0,w]; lat in
// [-90,90] -> y in [0,h] (inverted, since screen y grows downward).
function project(lat, lon, w, h) {
  const x = (lon + 180) / 360 * w
  const y = (90 - lat) / 180 * h
  return [x, y]
}

function drawLand(ctx, w, h) {
  ctx.fillStyle = '#080c12'
  ctx.fillRect(0, 0, w, h)
  if (!_landFeature) return
  ctx.fillStyle = '#111a24'
  ctx.strokeStyle = '#1e2d3d'
  ctx.lineWidth = 0.5
  for (const feat of _landFeature.features || [_landFeature]) {
    const geom = feat.geometry
    if (!geom) continue
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
    for (const poly of polys) {
      for (const ring of poly) {
        ctx.beginPath()
        ring.forEach(([lon, lat], i) => {
          const [x, y] = project(lat, lon, w, h)
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        })
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
    }
  }
}

/**
 * A minimal map controller bound to a <canvas>. Call landedHost(hostKey)
 * every time onShardUploaded reports a new host for the active upload --
 * this draws a gold corridor from Detroit to that host (if geo data
 * exists for it; skipped silently otherwise, per law) and a gold mark at
 * the host. reset() clears marks for a new upload. destroy() stops the
 * resize listener.
 */
export function createUploadMap(canvas, captionEl) {
  const ctx = canvas.getContext('2d')
  let marks = []      // {lat, lon}
  let ready = false

  function resize() {
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.max(1, Math.round(rect.width))
    canvas.height = Math.max(1, Math.round(rect.height))
    render()
  }

  function render() {
    const w = canvas.width, h = canvas.height
    if (!w || !h) return
    drawLand(ctx, w, h)
    if (!ready) return
    const [ox, oy] = project(ORIGIN.lat, ORIGIN.lon, w, h)
    // Origin mark (Detroit) -- small, steady.
    ctx.fillStyle = '#f59e0b'
    ctx.beginPath(); ctx.arc(ox, oy, 3, 0, Math.PI * 2); ctx.fill()
    for (const m of marks) {
      const [x, y] = project(m.lat, m.lon, w, h)
      // City corridor: a gently-curved line, not per-shard spaghetti --
      // one curve per DISTINCT host that landed a shard this upload, not
      // one per shard event (dedup happens in landedHost() below).
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)'
      ctx.lineWidth = 1.2
      const midX = (ox + x) / 2, midY = Math.min(oy, y) - 18
      ctx.beginPath()
      ctx.moveTo(ox, oy)
      ctx.quadraticCurveTo(midX, midY, x, y)
      ctx.stroke()
      ctx.fillStyle = '#f59e0b'
      ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill()
    }
  }

  const seenHosts = new Set()

  async function init() {
    await ensureAssets()
    ready = true
    resize()
  }

  function landedHost(hostKey) {
    if (!hostKey || seenHosts.has(hostKey)) return
    seenHosts.add(hostKey)
    const geo = _geoCache && _geoCache[hostKey]
    // "If a host has no lat/long, skip the pin." -- exactly per law, no
    // fallback placement, no fake location.
    if (!geo || typeof geo.lat !== 'number' || typeof geo.lon !== 'number') return
    marks.push({ lat: geo.lat, lon: geo.lon })
    if (captionEl) captionEl.textContent = marks.length + ' host' + (marks.length === 1 ? '' : 's') + ' written to'
    render()
  }

  function reset() {
    marks = []
    seenHosts.clear()
    if (captionEl) captionEl.textContent = ''
    render()
  }

  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  init()

  return {
    landedHost,
    reset,
    destroy() { ro.disconnect() },
  }
}
