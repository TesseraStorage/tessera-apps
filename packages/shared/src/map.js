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
// UPDATE (2026-09-14, "tessera-web-map-arcs"): "Arcs at instigation... If
// the SDK only names a host when the shard finishes, start the arc when
// that host is first known (first inflight), and print that in Output --
// do not add a second occupy to fake a full bag at t=0." Confirmed by a
// full string search of the vendored wasm binary: onShardUploaded is the
// ONLY upload-side callback that exists -- there is no separate "shard
// started" / "host assigned" event. So "first known" and "shard
// finishes" are the SAME signal here; a host's arc starts the moment
// onShardUploaded first reports that hostKey, which is also the exact
// instant the previous task's progress-counter tick already fires for
// it. This is NOT arcs drawn purely at t=0 (that would require a second
// host-list read this module deliberately does not make) -- see the
// Output block's "arcs before first shard land" field for the honest
// answer. landedHost() now ALSO starts a traveling glow-dot animation
// along the new arc instead of just plotting a static mark immediately.
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

// NAMED RATE CONSTANT (packet law: "one named constant (ms to traverse
// an arc). Operator will change the number later. Do not hide it.") --
// how long a glow-dot takes to travel from Detroit to a landed host.
export const ARC_TRAVEL_MS = 900

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

// Small radial glow instead of a flat 1px dot (packet law #4).
function drawGlow(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * A minimal map controller bound to a <canvas>. Call landedHost(hostKey)
 * every time onShardUploaded reports a new host for the active upload --
 * this draws a gold arc from Detroit to that host (if geo data exists
 * for it; skipped silently otherwise, per law), then animates a glow-dot
 * traveling along the arc over ARC_TRAVEL_MS, leaving a quieter residual
 * glow at the landed end. reset() clears everything for a new upload.
 * destroy() stops the resize/animation loop.
 */
export function createUploadMap(canvas, captionEl) {
  const ctx = canvas.getContext('2d')
  let landed = []      // {lat, lon} -- residual glow, travel finished
  let traveling = []   // {lat, lon, startedAt} -- glow-dot still en route
  let ready = false
  let rafId = null

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
    // Origin mark (Detroit) -- small, steady glow, not a flat dot.
    drawGlow(ctx, ox, oy, 6, 'rgba(245, 158, 11, 0.9)')

    const now = Date.now()
    let anyTraveling = false
    for (const m of landed.concat(traveling)) {
      const [x, y] = project(m.lat, m.lon, w, h)
      // City corridor: a gently-curved arc, not per-shard spaghetti --
      // one curve per DISTINCT host that landed a shard this upload.
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)'
      ctx.lineWidth = 1.2
      const midX = (ox + x) / 2, midY = Math.min(oy, y) - 18
      ctx.beginPath()
      ctx.moveTo(ox, oy)
      ctx.quadraticCurveTo(midX, midY, x, y)
      ctx.stroke()
    }
    // Landed hosts: quieter residual glow (packet law #4).
    for (const m of landed) {
      const [x, y] = project(m.lat, m.lon, w, h)
      drawGlow(ctx, x, y, 5, 'rgba(245, 158, 11, 0.55)')
    }
    // Traveling glow-dots: interpolate position along the same
    // quadratic curve used above, over ARC_TRAVEL_MS.
    for (const m of traveling) {
      const t = Math.min(1, (now - m.startedAt) / ARC_TRAVEL_MS)
      const [x, y] = project(m.lat, m.lon, w, h)
      const midX = (ox + x) / 2, midY = Math.min(oy, y) - 18
      // Quadratic Bezier point at parameter t.
      const px = (1 - t) * (1 - t) * ox + 2 * (1 - t) * t * midX + t * t * x
      const py = (1 - t) * (1 - t) * oy + 2 * (1 - t) * t * midY + t * t * y
      drawGlow(ctx, px, py, 7, 'rgba(250, 204, 21, 0.95)')
      if (t < 1) anyTraveling = true
    }
    // Promote finished travels to the residual-landed list, on the next
    // frame -- avoids mutating the array mid-render.
    if (traveling.length && traveling.every(m => (now - m.startedAt) >= ARC_TRAVEL_MS)) {
      landed = landed.concat(traveling)
      traveling = []
    }
    if (anyTraveling) {
      rafId = requestAnimationFrame(render)
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
    traveling.push({ lat: geo.lat, lon: geo.lon, startedAt: Date.now() })
    if (captionEl) {
      const total = landed.length + traveling.length
      captionEl.textContent = total + ' host' + (total === 1 ? '' : 's') + ' written to'
    }
    if (!rafId) render()
  }

  function reset() {
    landed = []
    traveling = []
    seenHosts.clear()
    if (rafId) { cancelAnimationFrame(rafId); rafId = null }
    if (captionEl) captionEl.textContent = ''
    render()
  }

  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  init()

  return {
    landedHost,
    reset,
    destroy() { ro.disconnect(); if (rafId) cancelAnimationFrame(rafId) },
  }
}
