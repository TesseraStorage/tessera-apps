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
//
// IP GEO FALLBACK ADDED (2026-09-18, "tessera-web-origin-ip-geo"):
// browser geolocation almost never actually resolves in practice (this
// app never triggers the permission prompt, only reads a position if
// it happens to already be granted from some other context) -- so
// nearly every visitor fell straight through to Dubai. trySetOrigin
// FromGeolocation() now tries real geolocation first (unchanged), then
// a keyless IP-geolocation lookup (ipwho.is, CORS-open, no server
// proxy needed) before finally falling back to Dubai. Still zero
// permission prompts, still fails quiet on any error -- same contract,
// just a better-populated middle rung.
let ORIGIN = { lat: 25.2, lon: 55.3 }  // Dubai, UAE -- default per this task's law

// NAMED RATE/COUNT CONSTANTS (packet law: "Operator will turn these
// later. Keep them exported." Re-affirmed 2026-09-15 "tessera-web-
// map-follow": "Do not invent traveling-dot color variants, speed, or
// frequency knobs. Leave ARC_TRAVEL_MS and DOTS_PER_ARC exported.")
export const ARC_TRAVEL_MS = 3200   // ms for one glow-dot to traverse an arc (2026-09-16 "tessera-web-handoff adjustments": +50% speed, was 4800; 2026-09-14 "tessera-web-map-tune": half speed, was 2400)
export const DOTS_PER_ARC = 2       // simultaneous glow-dots per active arc, staggered (2026-09-14 "tessera-web-map-tune": halved, was 4)

// PER-SHARD FADE (2026-09-15, "tessera-web-map-follow" law #4): "Finish
// of that shard: that line fades out (~800-1200ms alpha)." Not a knob
// this packet names as exported/tunable (unlike ARC_TRAVEL_MS/
// DOTS_PER_ARC) -- kept as a plain internal constant, midpoint of the
// packet's own named range.
const SHARD_FADE_MS = 1000

// LINE LIFETIME RULE (2026-09-16, "tessera-web-encode-hold", SIMPLIFIED
// FINAL: prior "5s-or-write-completion, whichever is longer" logic
// could not be made to visibly work across several attempts and was
// abandoned by explicit operator instruction -- "let's give up.
// Here's what we'll do: each line lasts a flat 4 seconds, from write.
// After last shard, we move on to 'waiting for pin confirmation.'"
// So: every line is drawn at write-landing (the only moment the SDK
// gives us a hook) and lasts a FLAT LINE_FLOOR_MS, no per-shard
// completion check, no whole-object override. tripFade() is fully
// opaque until `t.visibleUntil`, then fades linearly to 0 over
// SHARD_FADE_MS -- unchanged mechanically from before.
function tripFade(t, now) {
  if (now < t.visibleUntil) return 1
  return Math.max(0, 1 - (now - t.visibleUntil) / SHARD_FADE_MS)
}
const LINE_FLOOR_MS = 4000

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

// lookupGeo(hostKey): (2026-09-16, "tessera-web-add-hang-map400")
// exported read-only wrapper so callers OUTSIDE this module (web-ui.js,
// persisting a landed shard via files.js's addMapShard) can resolve
// the exact same {lat, lon} this module would use for that hostKey --
// without duplicating normalizeHostKey/_geoCache logic, and without a
// second geo.json fetch (ensureAssets() is idempotent/cached; this
// only reads the already-loaded _geoCache, no network). Returns null
// exactly when shardLanded() would also skip the pin (no geo data) --
// same "skip records with no lat/long" rule applies to persistence.
export function lookupGeo(hostKey) {
  return geoLookup(hostKey)
}

// Quiet, one-shot geolocation: only reads a position if the permission
// is ALREADY granted (never triggers the browser's permission prompt
// itself), and fails silently (falls through to IP geolocation, then
// Dubai) on any denial, error, or missing API. Called once, lazily,
// from createUploadMap's init() -- not on page load/preload.
//
// IP GEOLOCATION FALLBACK (2026-09-18, "tessera-web-origin-ip-geo"):
// operator asked how to determine the user's approximate location
// besides asking them to type it in. Browser geolocation ALREADY
// covers the most-accurate case, but only fires if permission was
// separately granted at some point -- which almost never happens in
// practice (this app never prompts for it), so nearly every visit fell
// straight through to the hardcoded Dubai default. IP-based
// geolocation needs no permission prompt at all and resolves for
// essentially every visitor, so it now sits as the middle rung: try
// real geolocation first (still silent/no-prompt, unchanged), then IP
// geo (new), then Dubai only if both fail.
//
// ipwho.is chosen specifically because it's free, keyless, HTTPS, and
// serves `access-control-allow-origin: *` (confirmed live via curl) --
// callable directly from the browser with a plain fetch(), no server-
// side proxy needed. Same "fail quiet, never block the map" contract
// as the geolocation branch: any network error, timeout, or malformed
// response falls through to Dubai without throwing or logging noisily.
// A short client-side timeout (2s, matching the geolocation branch's
// own timeout) keeps a slow/blocked request from delaying map init.
async function fetchIpGeoOrigin() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const resp = await fetch('https://ipwho.is/', { signal: controller.signal })
    clearTimeout(timer)
    if (!resp.ok) return null
    const data = await resp.json()
    if (!data || data.success === false) return null
    if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') return null
    return { lat: data.latitude, lon: data.longitude }
  } catch (_) {
    return null  // fail quiet, let the caller fall through to Dubai
  }
}

async function trySetOriginFromGeolocation() {
  try {
    if (navigator.geolocation && navigator.permissions) {
      const status = await navigator.permissions.query({ name: 'geolocation' })
      if (status.state === 'granted') {
        const gotIt = await new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => { ORIGIN = { lat: pos.coords.latitude, lon: pos.coords.longitude }; resolve(true) },
            () => resolve(false),      // fail quiet, try IP geo next
            { timeout: 2000, maximumAge: 300000 },
          )
        })
        if (gotIt) return
      }
    }
  } catch (_) { /* fail quiet, try IP geo next */ }
  // IP GEO FALLBACK: only reached if browser geolocation wasn't
  // granted, wasn't available, or itself failed/timed out above.
  const ipGeo = await fetchIpGeoOrigin()
  if (ipGeo) ORIGIN = ipGeo
  // else: Dubai stays (the module-level default above), exactly as
  // before this fallback existed.
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
        // right borders. Fixed by starting a NEW subpath (moveTo instead
        // of lineTo) whenever the raw longitude jumps by more than 180
        // degrees between consecutive ring points.
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

// Small radial glow. Still used as-is for traveling dots (2026-09-16
// "sharper fixed dots" packet: "Traveling dots, no change").
function drawGlow(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

// FIXED-DOT LOOK (2026-09-16, "sharper fixed dots", refined same day
// per operator reaction to the 2x2 version -- "try one pixel, halo a
// little dimmer"): "make them 2x2 pixels, as bright as the system
// enables, then a modest halo around each." Used for the origin mark
// and landed-shard pins only -- the old wide drawGlow() core (radius =
// PIN_RADIUS, soft radial falloff from center) read as a blur with no
// crisp point. This keeps a halo (still a radialGradient, just
// tighter/dimmer than before) but adds a genuinely sharp core: a
// solid, non-antialiased-looking 1x1 device-pixel square at full alpha
// (1), drawn with fillRect (not arc/fill, which always antialiases a
// circle's edge at this size) so the core itself reads as sharp rather
// than a blurred nub. Halo radius is deliberately modest (6px) vs. the
// fixed dot's old PIN_RADIUS-based glow -- "modest," not the previous
// wide wash; halo alpha dimmed further (0.45 -> 0.3) same day.
const FIXED_DOT_HALO_RADIUS = 6
const FIXED_DOT_HALO_ALPHA = 0.3  // halo peak alpha; core is always 1 (opaque)

function drawSharpDot(ctx, x, y, color) {
  // Modest halo first (so the core paints on top, not underneath it).
  const g = ctx.createRadialGradient(x, y, 0, x, y, FIXED_DOT_HALO_RADIUS)
  g.addColorStop(0, color.replace(/, ?1\)$/, `, ${FIXED_DOT_HALO_ALPHA})`))
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, FIXED_DOT_HALO_RADIUS, 0, Math.PI * 2)
  ctx.fill()

  // Sharp 1x1 core, full brightness -- device pixels, not CSS px, so
  // it stays crisp under devicePixelRatio scaling the canvas already
  // applies elsewhere in this file.
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1)
}

function bezierPoint(t, ox, oy, midX, midY, x, y) {
  const px = (1 - t) * (1 - t) * ox + 2 * (1 - t) * t * midX + t * t * x
  const py = (1 - t) * (1 - t) * oy + 2 * (1 - t) * t * midY + t * t * y
  return [px, py]
}

// MAP COLOR (operator, 2026-09-15, "tessera-web-look-v1", brightened
// 2026-09-15 "tessera-web-map-follow" law #5/#6):
// "Stationary pinpoints: brighter, slightly smaller." "Lines must look
// precise: brighter and sharper... thinner stroke, no soft smear, no
// wide glow on the line itself."
const GLOW_WHITE = 'rgba(255, 255, 255, 1)'  // brighter than look-v1's 0.95-alpha #F3F6FA -- still the white family, just punchier
const PIN_RADIUS = 4   // was 6 (origin) / 5 (landed) in look-v1 -- "slightly smaller core"
const STROKE_GOLD = 'rgba(245, 158, 11, '   // outbound arcs -- append alpha + ')'
const DOT_GOLD = 'rgba(250, 204, 21, 0.95)'     // outbound traveling dots -- unchanged, law #6 only raises LINE alpha, dots "may stay the current gold/cyan"
const STROKE_CYAN = 'rgba(62, 198, 224, '       // inbound arcs -- append alpha + ')'
const DOT_CYAN = 'rgba(62, 198, 224, 0.95)'     // inbound traveling dots -- MAP2 #3EC6E0 family, unchanged
// SHARPER LINES (law #6): was 0.35 alpha / 1.2px width with a soft glow
// look from the wide radial-gradient dots sharing the same visual
// space as the stroke. Raised alpha, thinned the stroke itself -- the
// stroke has never used drawGlow() (that's only for pins/dots), so
// "no wide glow on the line" just means: don't widen lineWidth, don't
// lower alpha. 0.75 alpha / 0.8px reads as a crisp, bright thread.
const LINE_ALPHA = 0.75
const LINE_WIDTH = 0.8

// PIN DISPERSION (2026-09-15, "tessera-web-map-follow" law #5): "Many
// shards land on one host. Stacked pins look like one. Disperse them."
// Sunflower seed arrangement on a 25px-radius disk around the
// projected host pixel -- deterministic per (hostKey, shard index on
// that host), so a given shard's pin never wanders frame to frame.
// Formula is the packet's own, verbatim:
//   theta = i * PI * (3 - sqrt(5))
//   r = 25 * sqrt((i + 0.5) / n)
// "The center of gravity of that cloud is the exact host pixel. Mean
// offset is zero." -- true of the sunflower spiral by construction
// (points spread symmetrically around the origin as n grows), not
// something this code has to separately enforce.
const PIN_DISPERSE_RADIUS = 25
function sunflowerOffset(i, n) {
  if (n <= 1) return [0, 0]  // single shard on this host: no offset, sits exactly on the host pixel
  const theta = i * Math.PI * (3 - Math.sqrt(5))
  const r = PIN_DISPERSE_RADIUS * Math.sqrt((i + 0.5) / n)
  return [r * Math.cos(theta), r * Math.sin(theta)]
}

/**
 * A minimal map controller bound to a <canvas>.
 *
 * showCandidates(hostKeys): called ONCE at Add start, with the single
 * host-list fetch's results -- draws QUIET, un-lit candidate pins for
 * up to 30 of them that have geo data.
 *
 * shardLanded(hostKey, dir): called once per SDK shard-progress event
 * (2026-09-15, "tessera-web-map-follow" law #4 -- "a line is one
 * shard," never "the object"). onShardUploaded/onShardDownloaded are
 * the SDK's ONLY hooks that name a hostKey (confirmed again this
 * packet by re-grepping sia_storage_wasm.d.ts for onShardUploading/
 * onShardStarted/equivalent -- neither exists; UploadOptions/
 * DownloadOptions/PackedUploadOptions expose only onShardUploaded/
 * onShardDownloaded). SIMPLIFIED FINAL (2026-09-16): every line lasts
 * a FLAT LINE_FLOOR_MS (4s) from the moment it's drawn (landing --
 * the only hook available). No per-shard completion check, no
 * write-commence backdating -- several attempts at that were tried
 * and abandoned same day per explicit operator instruction ("let's
 * give up... each line lasts a flat 4 seconds, from write"; the
 * follow-up messaging for "last shard landed" is a separate concern,
 * "waiting for pin confirmation," handled outside this file).
 * `landedHost` is kept as an alias below for any external caller
 * still using the old name.
 *
 * completeWrite(): called once the whole object (slab/file) finishes
 * (success or fail) -- i.e. the last shard has landed. Does NOT touch
 * trips or pins -- every line already fades on its own flat 4s clock,
 * independent of object completion. Kept only as a "no more shards
 * coming" signal so a caller can kick the RAF loop if it happened to
 * be stopped.
 */
export function createUploadMap(canvas, captionEl, onLanded) {
  const ctx = canvas.getContext('2d')
  let candidates = []   // {lat, lon} -- quiet, un-lit, shown at Add start
  let pins = []          // {lat, lon, hostKey, dxPin, dyPin} -- one per LANDED shard, dispersed, never cleared by completeWrite/fade
  // LINE LIFETIME (2026-09-16, "tessera-web-encode-hold", SIMPLIFIED
  // FINAL): every trip fades on a FLAT LINE_FLOOR_MS (4s) clock from
  // the moment it's drawn (landing) -- no per-shard real-transfer
  // check, no write-commence backdating, no whole-object override.
  // Several more elaborate formulas were tried and abandoned same day
  // (see shardLanded()'s own comment) after repeated live reports that
  // lines were disappearing far too early. `startedAt` doubles as both
  // the traveling-dot phase-animation reference AND now the line's own
  // opacity-clock reference (previously two different fields --
  // collapsed back into one now that there's no separate commence-time
  // math to keep isolated from the dot's phase timing).
  let trips = []         // {lat, lon, hostKey, dir, startedAt, visibleUntil, fadeAt} -- one per shard trip
  const hostShardCounts = new Map()  // hostKey -> count of shards landed there so far, for the sunflower index/n
  let ready = false
  let rafId = null

  function resize() {
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.max(1, Math.round(rect.width))
    canvas.height = Math.max(1, Math.round(rect.height))
    render()
  }

  // Recompute every pin's dispersed offset for a host whenever a NEW
  // shard lands there -- "n grows as shards land; recompute that
  // host's cloud" (law #5). Stable per (hostKey, index): the i-th
  // shard on a host always gets sunflowerOffset(i, n), so existing
  // pins' angles never change, only the shared `n` denominator grows,
  // which the packet's own formula already accounts for (nothing
  // "wanders" -- r depends on i and n together, deterministically).
  function recomputeHostCloud(hostKey) {
    const n = hostShardCounts.get(hostKey) || 0
    let i = 0
    for (const p of pins) {
      if (p.hostKey !== hostKey) continue
      const [dx, dy] = sunflowerOffset(i, n)
      p.dxPin = dx; p.dyPin = dy
      i++
    }
  }

  function render() {
    const w = canvas.width, h = canvas.height
    if (!w || !h) return
    drawLand(ctx, w, h)
    if (!ready) return
    const [ox, oy] = project(ORIGIN.lat, ORIGIN.lon, w, h)
    // Origin mark -- small, steady glow. White family, brighter/
    // smaller than look-v1 (law #5).
    drawSharpDot(ctx, ox, oy, GLOW_WHITE)

    const now = Date.now()

    // Quiet candidate pins (Add-start preview, real hosts, un-lit).
    for (const c of candidates) {
      const [x, y] = project(c.lat, c.lon, w, h)
      drawGlow(ctx, x, y, 3, 'rgba(148, 163, 184, 0.35)')  // deliberately dim/neutral, not gold
    }

    // Arcs (curved lines) -- one per still-visible-or-fading shard TRIP,
    // not per host and not per object (law #4). Each trip fades on its
    // OWN clock, independent of every other trip -- "a finished
    // shard's line fades while others still run." SHARPER (law #6):
    // higher alpha, thinner stroke than look-v1.
    //
    // FLOOR (2026-09-16, "tessera-web-encode-hold"): a trip stays at
    // FULL opacity (fade=1, no alpha falloff at all) until
    // `t.visibleUntil` -- "Each line lasts max(5 seconds, that shard's
    // real transfer). A 1-second shard still shows its line for 5
    // seconds." Only AFTER visibleUntil does the alpha clock (still
    // SHARD_FADE_MS long) start counting down. tripFade() is the one
    // place this rule lives; every reader below (arcs, dots, cull)
    // calls it instead of re-deriving "is this trip still showing" on
    // its own, so the floor can never accidentally apply in one place
    // and not another.
    ctx.lineWidth = LINE_WIDTH
    for (const dir of ['upload', 'download']) {
      const stroke = dir === 'download' ? STROKE_CYAN : STROKE_GOLD
      let any = false
      for (const t of trips) {
        if (t.dir !== dir) continue
        const fade = tripFade(t, now)
        if (fade <= 0) continue
        if (!any) { ctx.beginPath(); any = true }
        ctx.strokeStyle = stroke + (LINE_ALPHA * fade) + ')'
        const [x, y] = project(t.lat, t.lon, w, h)
        const midX = (ox + x) / 2, midY = Math.min(oy, y) - 18
        ctx.moveTo(ox, oy)
        ctx.quadraticCurveTo(midX, midY, x, y)
        // Per-trip alpha means per-trip stroke() -- can't batch this
        // into one beginPath/stroke like look-v1 did (that assumed a
        // single shared fade for the whole direction); a handful of
        // simultaneous in-flight trips is cheap either way.
        ctx.stroke()
        ctx.beginPath()
      }
    }

    // Landed pin dots: one per LANDED SHARD, dispersed around its host
    // pixel on a 25px sunflower disk (law #5) -- never stacked, never
    // cleared by fade or completeWrite. White family, brighter/
    // smaller than look-v1.
    for (const p of pins) {
      const [hx, hy] = project(p.lat, p.lon, w, h)
      drawSharpDot(ctx, hx + p.dxPin, hy + p.dyPin, GLOW_WHITE)
    }

    // Traveling glow-dots: DOTS_PER_ARC dots per still-visible trip,
    // staggered evenly across ARC_TRAVEL_MS. Removed entirely once
    // that trip's OWN fade reaches 0 (below, in the cull step) --
    // dots never outlive their own line. Unaffected by the floor
    // change above other than reading the same tripFade() gate --
    // ARC_TRAVEL_MS/DOTS_PER_ARC themselves stay exactly as exported,
    // per law ("Do not change ARC_TRAVEL_MS / DOTS_PER_ARC as a
    // substitute for this floor").
    let anyAnimating = false
    for (const t of trips) {
      const fade = tripFade(t, now)
      if (fade <= 0) continue
      anyAnimating = true
      const [x, y] = project(t.lat, t.lon, w, h)
      const midX = (ox + x) / 2, midY = Math.min(oy, y) - 18
      const dotColor = (t.dir === 'download') ? DOT_CYAN : DOT_GOLD
      // DIRECTION (2026-09-16, "tessera-web-handoff adjustments"): the arc's
      // bezier is always defined origin(t=0) -> host(t=1) -- that part is
      // unchanged. For 'download' (client reading a file, host-to-origin),
      // the traveling dot must visually move the OTHER way: host -> origin
      // as real time elapses. Flipping the bezier parameter (1 - tt) rather
      // than swapping the curve's own endpoints keeps the arc/midpoint math
      // above (and the line/fade code, which never reads direction) exactly
      // as-is -- only the dot's position-over-time is reversed.
      for (let i = 0; i < DOTS_PER_ARC; i++) {
        const stagger = (i / DOTS_PER_ARC) * ARC_TRAVEL_MS
        const dotElapsed = (now - t.startedAt - stagger)
        if (dotElapsed < 0) continue
        const tt = (dotElapsed % ARC_TRAVEL_MS) / ARC_TRAVEL_MS
        const tEff = (t.dir === 'download') ? (1 - tt) : tt
        const [px, py] = bezierPoint(tEff, ox, oy, midX, midY, x, y)
        drawGlow(ctx, px, py, 7, dotColor)
      }
    }

    // Cull fully-faded trips so the array doesn't grow unbounded
    // across a long-running upload/download.
    if (trips.length) {
      trips = trips.filter(t => tripFade(t, now) > 0)
    }

    if (anyAnimating) {
      rafId = requestAnimationFrame(render)
    } else {
      rafId = null
    }
  }

  // seedPins(records): (2026-09-16, "tessera-web-add-hang-map400")
  // "On Files + map open, paint the stored pins before any new Add. No
  // network for that paint." records are ALREADY-RESOLVED {lat, lon,
  // hostKey} shard records read back from localStorage (files.js's
  // getMapShards()) -- this function does zero geo lookup and zero
  // hosts() call, it only turns persisted records into the same `pins`
  // shape shardLanded() already draws from, recomputing each host's
  // sunflower dispersion exactly like a live landing would. Called
  // once, at map-open time, BEFORE any live Add starts -- reset()
  // (called at the start of every new Add) clears these same pins
  // along with live ones, matching "no landed shard is treated
  // specially" once painted.
  function seedPins(records) {
    for (const rec of records || []) {
      if (!rec || typeof rec.lat !== 'number' || typeof rec.lon !== 'number') continue
      const hostKey = rec.hostKey || null
      const i = hostShardCounts.get(hostKey) || 0
      hostShardCounts.set(hostKey, i + 1)
      pins.push({ lat: rec.lat, lon: rec.lon, hostKey, dxPin: 0, dyPin: 0 })
    }
    // Recompute dispersion once per distinct host after all records are
    // in, not per-record -- cheaper, and matches shardLanded()'s own
    // per-host recompute semantics (only the affected host's cloud
    // needs a new n).
    for (const hostKey of hostShardCounts.keys()) recomputeHostCloud(hostKey)
    render()
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
  function showCandidates(hostKeys) {
    candidates = []
    for (const key of hostKeys || []) {
      if (candidates.length >= 30) break
      const geo = geoLookup(key)
      if (geo) candidates.push({ lat: geo.lat, lon: geo.lon })
    }
    render()
  }

  // shardLanded: the per-shard entry point (2026-09-15, "tessera-web-
  // map-follow"). Draws one trip (arc + DOTS_PER_ARC traveling dots).
  //
  // LINE LIFETIME (2026-09-16, "tessera-web-encode-hold", SIMPLIFIED
  // FINAL -- all prior same-day "5s-or-real-transfer" formulas REMOVED
  // per explicit operator instruction to abandon that approach): every
  // line lasts a FLAT LINE_FLOOR_MS (4s) from the moment it's drawn
  // (shard landing -- the only SDK hook available; there is no
  // separate "shard started" event). `transferMs` is no longer read
  // or used for line timing at all.
  function shardLanded(hostKey, dir, transferMs) {
    if (!hostKey) return
    const geo = geoLookup(hostKey)
    // "Skip hosts with no lat/long. Do not invent pins. Do not call
    // hosts() to fill gaps." -- no fallback placement.
    if (!geo) return
    const now = Date.now()
    trips.push({ lat: geo.lat, lon: geo.lon, hostKey, dir: dir || 'upload', startedAt: now, visibleUntil: now + LINE_FLOOR_MS, fadeAt: now })

    // Dispersed pin (law #5): index is this host's shard count BEFORE
    // incrementing (0-based), n is the count AFTER.
    const i = hostShardCounts.get(hostKey) || 0
    hostShardCounts.set(hostKey, i + 1)
    pins.push({ lat: geo.lat, lon: geo.lon, hostKey, dxPin: 0, dyPin: 0 })
    recomputeHostCloud(hostKey)

    // PERSIST (2026-09-16, "tessera-web-add-hang-map400"): "New
    // landings append, then trim to 400." onLanded is this
    // controller's optional 3rd constructor arg -- when the caller
    // passed one (web-ui.js, wired straight to files.js's
    // addMapShard), every live shard that gets a real pin drawn here
    // ALSO gets persisted with the exact same resolved geo, same
    // hostKey, same dir. No new lookup, no new network call -- reuses
    // the `geo` this function already resolved above. Scoped to
    // 'upload' dir only -- this packet's own law only names "During a
    // live Add, lines still follow the write... New landings append."
    // A download's shardLanded call still draws its cyan trip/pin live
    // (unchanged), it just doesn't ALSO write a new persisted record --
    // out of this packet's stated scope.
    if (onLanded && (dir || 'upload') === 'upload') onLanded({ hostKey, lat: geo.lat, lon: geo.lon, dir: dir || 'upload', at: now })

    if (!rafId) render()
  }
  // Back-compat alias -- some call sites still say "landedHost".
  const landedHost = shardLanded

  // completeWrite(): the object (slab/file) has finished (or failed)
  // -- i.e. the last shard has landed. Does NOT touch trips or pins --
  // per the SIMPLIFIED FINAL rule (2026-09-16), every line already
  // fades on its own flat LINE_FLOOR_MS clock, independent of object
  // completion. Kept only as a "no more shards coming" signal so a
  // caller can kick the RAF loop if it happened to be stopped. The
  // operator's separate instruction -- "after last shard, we move on
  // to 'waiting for pin confirmation'" -- is a STATUS TEXT concern
  // (what the caller shows the user while sdk.pinObject() is in
  // flight), not a map-drawing concern; that messaging lives in
  // web-ui.js/files.js's own status-string plumbing, not here.
  function completeWrite() {
    if (!rafId) render()
  }

  function reset() {
    candidates = []
    pins = []
    trips = []
    hostShardCounts.clear()
    if (rafId) { cancelAnimationFrame(rafId); rafId = null }
    render()
  }

  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  init()

  return {
    showCandidates,
    shardLanded,
    landedHost,
    completeWrite,
    reset,
    seedPins,
    destroy() { ro.disconnect(); if (rafId) cancelAnimationFrame(rafId) },
  }
}
