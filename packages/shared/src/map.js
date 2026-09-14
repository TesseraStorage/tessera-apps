// @tessera/shared — Tessera Web upload map
//
// GEOGRAPHY FINDING (2026-09-14, "tessera-web-map-tune") -- OBSERVED,
// NOT FIXED HERE, PER LAW ("Geography question is observe + cite. Do
// not retune primary. Do not fake pins in empty oceans."):
//
// The Americas/Australia gap is NOT a map-code bug (not a geo.json
// miss, not a hostKey-normalize miss, not a projection clip). Root
// cause is upstream, in what a real customer's GET /hosts call actually
// returns:
//   - The full writable_pairs pool (indexd's "good for write" set) DOES
//     have real geographic spread: 293 hosts have geo.json entries, and
//     72 of those (24.6%) are in the Americas/AU bucket (lon < -30 or
//     lat < -10) -- queried directly against fleet.writable_pairs
//     JOIN host_geo.
//   - BUT Tessera Web's app key has no client_roles row, so hostfilter
//     (dataplane/hostfilter/main.go) treats it as an unknown customer.
//     Customers are served via serveWindowThrough with the Push list
//     from /var/lib/tessera/el-grande-recipe-log.jsonl (pushKeysFromRecipeLog),
//     NOT a random/geographic sample of writable_pairs -- it's the exact
//     order a human operator manually pushed hosts in on the El Grande
//     page, sliced to that recipe's own offer_n.
//   - Read the LIVE last line of that recipe log directly: offer_n=33,
//     primary_host_keys has 54 entries. Of the 33 actually served
//     (push_keys[:33]), 31 have geo.json entries and ALL 31 land in
//     Southeast Asia or Europe (Malaysia, Singapore, Thailand, China,
//     Lithuania, South Korea, Taiwan, Germany, Slovakia, Netherlands,
//     Estonia, UK, Spain, Finland, Bulgaria, Moldova, Romania, Ukraine,
//     Russia, France -- exhaustively checked every one of the 33).
//     ZERO Americas, ZERO Australia, in this specific served window.
//   - This is the current recipe log's own push order, not a mechanism
//     in this app or in map.js -- the "bag" (per this packet's own
//     phrasing) is Europe/Asia for THIS window. Printed as the finding,
//     per law; primary/El Grande's recipe was NOT retuned to fix it.
//
// PACKET LAW (2026-09-14, "tessera-web-map-progress"): "hosts() occupies.
// Do not call hosts() / GET /hosts to feed the map... use what the
// active upload already knows." Held strictly for two prior tasks (zero
// extra hosts() calls). THIS task's own law relaxes that specifically:
// "At most one host-list fetch per active upload, shared with the
// write. No polling loop." -- see showCandidates()/web-ui.js for the
// single call this permits.
//
// HOST KEY NORMALIZATION (2026-09-14, "tessera-web-map-30"): geo.json's
// keys are "ed25519:<64-hex-char>" (confirmed live:
// `ed25519:2a609b54c88295feda44401c4f86ee75fa244170548f82ae6540f98dff29f46d`,
// 72 chars total). The SDK's own .d.ts (node_modules/@siafoundation/
// sia-storage/wasm/sia_storage_wasm.d.ts) types Host.publicKey and
// ShardProgress.hostKey both as plain `string`, with NO documented exact
// format for ShardProgress.hostKey specifically -- only AppKey.publicKey()
// has an explicit JSDoc example ("ed25519:abc123..."), and Host.publicKey
// follows the same struct-field naming convention in the same binary, so
// the two are LIKELY already the same shape. But "likely" from static
// analysis is not "confirmed" -- there was no live vault to capture a
// real ShardProgress event and check empirically. normalizeHostKey()
// below is the defensive fix: try the raw key first, then a few cheap
// variants (missing "ed25519:" prefix, lowercased) before giving up and
// skipping the pin -- so if the mismatch the packet suspected is real,
// pins recover instead of silently all dropping; if it wasn't real, this
// is a no-op (exact match hits on the first try every time).
export function normalizeHostKey(key) {
  if (!key || typeof key !== 'string') return null
  const candidates = [
    key,
    key.toLowerCase(),
    key.startsWith('ed25519:') ? key : 'ed25519:' + key,
    key.startsWith('ed25519:') ? key.slice('ed25519:'.length) : key,
  ]
  return candidates
}

const GEO_URL = '/v2/tessera/geo/geo.json'
const LAND_TOPOJSON_URL = 'https://unpkg.com/world-atlas@2/land-110m.json'
const TOPOJSON_CLIENT_URL = 'https://unpkg.com/topojson-client@3'

// ORIGIN (2026-09-14, "tessera-web-map-30"): "Browser geolocation if the
// user already allowed it... If unknown: Dubai (25.2N, 55.3E), not
// Detroit." Mutable (was a frozen const) -- setOrigin() below updates it
// from a one-shot, permission-gated geolocation read; falls back to
// this Dubai default on any denial/error/timeout, always quiet (never
// prompts a permission dialog itself -- see setOrigin()'s permissions
// .query() check).
let ORIGIN = { lat: 25.2, lon: 55.3 }  // Dubai, UAE -- default per this task's law

// NAMED RATE/COUNT CONSTANTS (packet law: "Operator will turn these
// later. Keep them exported."):
export const ARC_TRAVEL_MS = 4800   // ms for one glow-dot to traverse an arc (2026-09-14 "tessera-web-map-tune": half speed, was 2400)
export const DOTS_PER_ARC = 2       // simultaneous glow-dots per active arc, staggered (2026-09-14 "tessera-web-map-tune": halved, was 4)

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

function geoLookup(hostKey) {
  if (!_geoCache) return null
  for (const candidate of normalizeHostKey(hostKey) || []) {
    if (_geoCache[candidate]) return _geoCache[candidate]
  }
  return null
}

// Quiet, one-shot geolocation: only reads a position if the permission
// is ALREADY granted (never triggers the browser's permission prompt
// itself), and fails silently (Dubai stays as ORIGIN) on any denial,
// error, or missing API. Called once, lazily, from createUploadMap's
// init() -- not on page load/preload.
async function trySetOriginFromGeolocation() {
  try {
    if (!navigator.geolocation || !navigator.permissions) return
    const status = await navigator.permissions.query({ name: 'geolocation' })
    if (status.state !== 'granted') return  // never prompt; Dubai stays
    await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => { ORIGIN = { lat: pos.coords.latitude, lon: pos.coords.longitude }; resolve() },
        () => resolve(),          // fail quiet, keep Dubai
        { timeout: 2000, maximumAge: 300000 },
      )
    })
  } catch (_) { /* fail quiet, keep Dubai */ }
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
        // STRAY LINE FIX (2026-09-14, "tessera-web-map-tune"): "Thin
        // horizontal line ~3/4 down the map... Cite the draw call."
        // Root cause: this equirectangular projection has NO antimeridian
        // wrap handling -- when a ring's consecutive points cross from
        // lon=+180 to lon=-180 (as Antarctica's ring does, since it
        // spans nearly the full width of the map), ctx.lineTo() draws a
        // straight chord STRAIGHT ACROSS the canvas connecting those two
        // x-positions, instead of two separate edges at the left and
        // right borders. That chord renders as a long, nearly-flat
        // horizontal stroke at Antarctica's latitude (~63-85S, which is
        // ~85-98% down a 480px-tall map -- "~3/4 down" is the visible
        // part of that same line before it exits toward the bottom
        // edge). Fixed by starting a NEW subpath (moveTo instead of
        // lineTo) whenever the raw longitude jumps by more than 180
        // degrees between consecutive ring points -- night land itself
        // (topojson source, dark fill/stroke colors) is unchanged.
        let started = false
        let prevLon = null
        ctx.beginPath()
        ring.forEach(([lon, lat]) => {
          const [x, y] = project(lat, lon, w, h)
          const crossedAntimeridian = prevLon !== null && Math.abs(lon - prevLon) > 180
          if (!started || crossedAntimeridian) { ctx.moveTo(x, y); started = true }
          else { ctx.lineTo(x, y) }
          prevLon = lon
        })
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
    }
  }
}

// Small radial glow instead of a flat 1px dot.
function drawGlow(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

function bezierPoint(t, ox, oy, midX, midY, x, y) {
  const px = (1 - t) * (1 - t) * ox + 2 * (1 - t) * t * midX + t * t * x
  const py = (1 - t) * (1 - t) * oy + 2 * (1 - t) * t * midY + t * t * y
  return [px, py]
}

// Arc fade-out timing after the write completes (packet law #4: "Arcs
// fade out. Destination glow stays. Origin glow stays.").
const ARC_FADE_MS = 1200

/**
 * A minimal map controller bound to a <canvas>.
 *
 * showCandidates(hostKeys): called ONCE at Add start (packet law: "Arcs
 * exist when Add starts, not when the shard lands"), with the single
 * host-list fetch's results -- draws QUIET, un-lit candidate pins (real
 * hosts from the real pool, not fake cities) for up to 30 of them that
 * have geo data. These are NOT gold write-arcs yet -- they mark "the
 * write might use one of these," never claiming certainty about which
 * ones will actually be picked.
 *
 * landedHost(hostKey): called every time onShardUploaded reports a shard
 * landing -- ONE call per SHARD TRIP, not deduped per host (packet law:
 * "10+20 -> 30 shard trips... if the same host takes two shards, two
 * trips on that path is allowed"). Promotes/replaces that host's
 * candidate pin (if any) with a real gold arc + DOTS_PER_ARC traveling
 * glow-dots over ARC_TRAVEL_MS.
 *
 * completeWrite(): called once the whole upload finishes -- starts the
 * arc fade-out. Landed/destination glows and the origin glow are NOT
 * cleared here (packet law #4) -- only reset() (called at the START of
 * the NEXT upload) clears them.
 */
export function createUploadMap(canvas, captionEl) {
  const ctx = canvas.getContext('2d')
  let candidates = []   // {lat, lon} -- quiet, un-lit, shown at Add start
  let landed = []       // {lat, lon, fadeAt} -- residual glow; fadeAt set once completeWrite() fires
  let traveling = []    // {lat, lon, startedAt} -- one entry per shard trip, DOTS_PER_ARC dots each
  let ready = false
  let rafId = null
  let completedAt = null

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
    // Origin mark -- small, steady glow. Stays through completion
    // (packet law #4: "Origin glow stays").
    drawGlow(ctx, ox, oy, 6, 'rgba(245, 158, 11, 0.9)')

    const now = Date.now()

    // Arc fade factor: 1.0 (full) before completeWrite(), easing to 0
    // over ARC_FADE_MS after it. Destination/origin glows never use
    // this factor -- only the curved arc lines do.
    let fade = 1
    if (completedAt !== null) {
      fade = Math.max(0, 1 - (now - completedAt) / ARC_FADE_MS)
    }

    // Quiet candidate pins (Add-start preview, real hosts, un-lit).
    for (const c of candidates) {
      const [x, y] = project(c.lat, c.lon, w, h)
      drawGlow(ctx, x, y, 3, 'rgba(148, 163, 184, 0.35)')  // --ink2-ish, deliberately dim/neutral, not gold
    }

    // Arcs (curved lines) for every landed + traveling shard trip --
    // "one corridor per shard trip, not one per unique host": duplicate
    // hosts draw a duplicate arc on the same path, which is allowed.
    if (fade > 0) {
      ctx.strokeStyle = 'rgba(245, 158, 11, ' + (0.35 * fade) + ')'
      ctx.lineWidth = 1.2
      for (const m of landed.concat(traveling)) {
        const [x, y] = project(m.lat, m.lon, w, h)
        const midX = (ox + x) / 2, midY = Math.min(oy, y) - 18
        ctx.beginPath()
        ctx.moveTo(ox, oy)
        ctx.quadraticCurveTo(midX, midY, x, y)
        ctx.stroke()
      }
    }

    // Landed destinations: quieter residual glow -- stays after
    // completion regardless of arc fade (packet law #4: "Destination
    // glow stays").
    for (const m of landed) {
      const [x, y] = project(m.lat, m.lon, w, h)
      drawGlow(ctx, x, y, 5, 'rgba(245, 158, 11, 0.55)')
    }

    // Traveling glow-dots: DOTS_PER_ARC dots per arc, staggered evenly
    // across ARC_TRAVEL_MS so several are visible on the same corridor
    // at once (packet law #3).
    let anyTraveling = false
    for (const m of traveling) {
      const [x, y] = project(m.lat, m.lon, w, h)
      const midX = (ox + x) / 2, midY = Math.min(oy, y) - 18
      for (let i = 0; i < DOTS_PER_ARC; i++) {
        const stagger = (i / DOTS_PER_ARC) * ARC_TRAVEL_MS
        const dotElapsed = (now - m.startedAt - stagger)
        if (dotElapsed < 0) continue  // this dot hasn't started its lap yet
        const t = (dotElapsed % ARC_TRAVEL_MS) / ARC_TRAVEL_MS
        const [px, py] = bezierPoint(t, ox, oy, midX, midY, x, y)
        drawGlow(ctx, px, py, 7, 'rgba(250, 204, 21, 0.95)')
      }
      // A trip's dots keep looping (packet law #3 doesn't say "stop
      // after one lap" -- "several dots on the same arc at once" reads
      // as a continuous effect while the trip is active) until
      // completeWrite() starts the fade; anyTraveling stays true the
      // whole time a trip is un-faded so the RAF loop keeps running.
      if (completedAt === null || fade > 0) anyTraveling = true
    }

    if (anyTraveling || (completedAt !== null && fade > 0)) {
      rafId = requestAnimationFrame(render)
    } else {
      rafId = null
    }
  }

  async function init() {
    await ensureAssets()
    await trySetOriginFromGeolocation()
    ready = true
    resize()
  }

  // Add-start candidate preview (packet law: "At Add start, take the
  // host list the SDK is about to use. One fetch if the write needs it
  // anyway; share it. Draw up to 30 destinations that have lat/long.")
  // Called from web-ui.js with the result of its OWN single sdk.hosts()
  // call -- this function does no fetching itself, just plots what it's
  // given.
  function showCandidates(hostKeys) {
    candidates = []
    for (const key of hostKeys || []) {
      if (candidates.length >= 30) break
      const geo = geoLookup(key)
      if (geo) candidates.push({ lat: geo.lat, lon: geo.lon })
    }
    render()
  }

  function landedHost(hostKey) {
    if (!hostKey) return
    const geo = geoLookup(hostKey)
    // "If a host has no lat/long, skip the pin." -- no fallback
    // placement, no fake location.
    if (!geo) return
    // One entry per SHARD TRIP (packet law #1) -- no seenHosts dedup.
    // A host reused across multiple shards gets multiple trips drawn on
    // the same path, which the packet explicitly allows.
    traveling.push({ lat: geo.lat, lon: geo.lon, startedAt: Date.now() })
    if (captionEl) {
      const total = landed.length + traveling.length
      captionEl.textContent = total + ' shard trip' + (total === 1 ? '' : 's') + ' written'
    }
    if (!rafId) render()
  }

  function completeWrite() {
    // Move every still-traveling trip to landed (their glow-dots stop
    // looping; the arc itself starts fading) and record the fade start.
    landed = landed.concat(traveling)
    traveling = []
    completedAt = Date.now()
    if (!rafId) render()
  }

  function reset() {
    candidates = []
    landed = []
    traveling = []
    completedAt = null
    if (rafId) { cancelAnimationFrame(rafId); rafId = null }
    if (captionEl) captionEl.textContent = ''
    render()
  }

  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  init()

  return {
    showCandidates,
    landedHost,
    completeWrite,
    reset,
    destroy() { ro.disconnect(); if (rafId) cancelAnimationFrame(rafId) },
  }
}
