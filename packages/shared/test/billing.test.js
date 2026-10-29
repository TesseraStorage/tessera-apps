// @tessera/shared — billing semantics tests (P6 Task 3, Decision 3)
//
// Hermetic: no browser, no network. `billing.js` takes fetch/isDesktop/bridge
// as injections, exactly like the FE composable's relative same-origin calls.
// The rendered view is covered separately by billing-view.test.js (DOM shim).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BILLING_SIGN_IN_URL, BILLING_SIGNED_OUT_MESSAGE, BILLING_DESKTOP_MESSAGE,
  BILLING_DESKTOP_APP_MESSAGE,
  topupRailOpen,
  TOPUP_MIN_USD, TOPUP_MAX_USD,
  toNumber, formatUsd, formatBytes, formatDateTime, formatDaysLeft,
  formatPlan, warningLabel, usedPercent, accountStatusLabel, accountKindLabel,
  accountStatusNotice, errorCode, BillingApiError, createBillingClient,
} from '../src/billing.js'

const SOURCE_PATH = fileURLToPath(new URL('../src/billing.js', import.meta.url))

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function rawResponse(status, text) {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

// ── formatting (billing-format.ts port) ──────────────────

test('formatUsd coerces strings and renders em dash for missing values', () => {
  assert.equal(formatUsd(null), '—')
  assert.equal(formatUsd(undefined), '—')
  assert.equal(formatUsd('nope'), '—')
  assert.equal(formatUsd(12.5), '$12.50')
  assert.equal(formatUsd('7.5'), '$7.50')
  assert.equal(formatUsd(0), '$0.00')
})

test('formatBytes is decimal (1 TB = 10^12) and handles null', () => {
  assert.equal(formatBytes(null), '—')
  assert.equal(formatBytes(undefined), '—')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1000), '1.00 kB')
  assert.equal(formatBytes(1500), '1.50 kB')
  assert.equal(formatBytes(10_000), '10.0 kB')
  assert.equal(formatBytes(100_000), '100 kB')
  assert.equal(formatBytes(1_000_000), '1.00 MB')
  assert.equal(formatBytes(1_000_000_000), '1.00 GB')
  assert.equal(formatBytes(1_500_000_000_000), '1.50 TB')
})

test('formatDaysLeft matches the FE copy', () => {
  assert.equal(formatDaysLeft(null), '—')
  assert.equal(formatDaysLeft(0), 'No days')
  assert.equal(formatDaysLeft(1), '1 day')
  assert.equal(formatDaysLeft(12), '12 days')
})

test('formatDateTime rejects empty/invalid values', () => {
  assert.equal(formatDateTime(null), '—')
  assert.equal(formatDateTime('not-a-date'), '—')
  assert.notEqual(formatDateTime('2026-11-01T00:00:00Z'), '—')
})

test('formatPlan maps known plan codes and passes through unknown ones', () => {
  assert.equal(formatPlan(null), '—')
  assert.equal(formatPlan('payg'), 'Pay as you go')
  assert.equal(formatPlan('starter'), 'Starter')
  assert.equal(formatPlan('enterprise'), 'Enterprise')
  assert.equal(formatPlan('custom'), 'custom')
})

test('warningLabel maps threshold warnings and humanizes others', () => {
  assert.equal(warningLabel('warning_7'), '7 days of balance remaining')
  assert.equal(warningLabel('warning_1'), '1 day of balance remaining')
  assert.equal(warningLabel('warning_0'), 'Balance exhausted')
  assert.equal(warningLabel('some_new_warning'), 'some new warning')
})

test('usedPercent clamps and returns null when unknown', () => {
  assert.equal(usedPercent(50, 200), 25)
  assert.equal(usedPercent(300, 200), 100)
  assert.equal(usedPercent(-5, 200), 0)
  assert.equal(usedPercent(null, 200), null)
  assert.equal(usedPercent(5, 0), null)
  assert.equal(usedPercent(5, null), null)
})

test('status/kind labels and notices cover every documented status', () => {
  assert.equal(accountStatusLabel('pending'), 'Awaiting first payment')
  assert.equal(accountStatusLabel('active'), 'Active')
  assert.equal(accountStatusLabel('past_due'), 'Past due')
  assert.equal(accountStatusLabel('suspended'), 'Suspended')
  assert.equal(accountStatusLabel('terminated'), 'Terminated')
  assert.equal(accountStatusLabel(null), '—')
  assert.equal(accountKindLabel('human'), 'Human')
  assert.equal(accountKindLabel('agent'), 'Agent')

  assert.equal(accountStatusNotice('active', false), null)
  assert.match(accountStatusNotice('pending', true), /Top up below/)
  assert.match(accountStatusNotice('pending', false), /not yet open/)
  assert.match(accountStatusNotice('past_due', true), /grace window/)
  assert.match(accountStatusNotice('past_due', false), /info@tessera\.storage/)
  assert.match(accountStatusNotice('suspended', false), /suspended/)
  assert.match(accountStatusNotice('terminated', false), /terminated/)
})

test('Decision 3 copy constants carry the load-bearing phrases', () => {
  assert.equal(BILLING_SIGN_IN_URL, 'https://tessera.storage/account')
  assert.match(BILLING_SIGNED_OUT_MESSAGE, /sign in at tessera\.storage\/account/i)
  assert.match(BILLING_DESKTOP_MESSAGE, /tessera login/)
  // Bug 7: the desktop APP wording must not reference the CLI at all.
  assert.match(BILLING_DESKTOP_APP_MESSAGE, /Welcome screen/)
  assert.ok(!/tessera login/.test(BILLING_DESKTOP_APP_MESSAGE))
  assert.equal(TOPUP_MIN_USD, 0.01)
  assert.equal(TOPUP_MAX_USD, 10000)
})

test('topupRailOpen follows the rail flag, not the master switch (item 3)', () => {
  const perRail = { topup_open: false, topup_rails: { nowpayments: true, x402: false } }
  assert.equal(topupRailOpen(perRail, 'nowpayments'), true)
  assert.equal(topupRailOpen(perRail, 'x402'), false)
  // Older API with no topup_rails falls back to the master switch.
  assert.equal(topupRailOpen({ topup_open: true }, 'x402'), true)
  assert.equal(topupRailOpen({ topup_open: false }, 'nowpayments'), false)
  assert.equal(topupRailOpen(null, 'nowpayments'), false)
  assert.equal(topupRailOpen({}, 'nowpayments'), false)
})

// ── error shape ──────────────────────────────────────────

test('errorCode reads flat, nested and string-detail shapes', () => {
  assert.equal(errorCode({ error: 'flat' }), 'flat')
  assert.equal(errorCode({ detail: { error: 'nested' } }), 'nested')
  assert.equal(errorCode({ detail: 'string_detail' }), 'string_detail')
  assert.equal(errorCode({ detail: { minimum_usd: '5' } }), null)
  assert.equal(errorCode(null), null)
  assert.equal(errorCode('nope'), null)
})

test('BillingApiError exposes status/code/detail', () => {
  const err = new BillingApiError(409, { detail: { error: 'below_asset_minimum', minimum_usd: '5' } })
  assert.equal(err.name, 'BillingApiError')
  assert.equal(err.status, 409)
  assert.equal(err.code, 'below_asset_minimum')
  assert.equal(err.detail.minimum_usd, '5')
  assert.match(err.message, /below_asset_minimum \(HTTP 409\)/)
  const bare = new BillingApiError(500, null)
  assert.equal(bare.code, null)
  assert.equal(bare.message, 'HTTP 500')
  assert.equal(bare.detail, null)
})

// ── web client (relative same-origin /api/v1) ────────────

test('getAccount is a same-origin cookie GET with no-store', async () => {
  const calls = []
  const client = createBillingClient({
    fetchFn: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(200, { billing_id: 'b_1', balance_usd: 7.5, topup_open: false })
    },
  })
  const acct = await client.getAccount()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/v1/account')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(calls[0].init.headers.Accept, 'application/json')
  assert.equal(acct.billing_id, 'b_1')
})

test('apiBase prefixes /api/v1 and trailing slashes are trimmed', async () => {
  const calls = []
  const client = createBillingClient({
    apiBase: 'https://tessera.storage/',
    fetchFn: async (url) => { calls.push(url); return jsonResponse(200, {}) },
  })
  await client.getAccount()
  assert.equal(calls[0], 'https://tessera.storage/api/v1/account')
})

test('401 rejects with a BillingApiError carrying unauthorized', async () => {
  const client = createBillingClient({
    fetchFn: async () => jsonResponse(401, { detail: { error: 'unauthorized' } }),
  })
  await assert.rejects(client.getAccount(), (err) => {
    assert.ok(err instanceof BillingApiError)
    assert.equal(err.status, 401)
    assert.equal(err.code, 'unauthorized')
    return true
  })
})

test('a non-JSON or empty 2xx is invalid_response, never a silent success', async () => {
  const html = createBillingClient({ fetchFn: async () => rawResponse(200, '<html>proxy</html>') })
  await assert.rejects(html.getAccount(), (err) => {
    assert.equal(err.code, 'invalid_response')
    return true
  })
  const empty = createBillingClient({ fetchFn: async () => rawResponse(200, '') })
  await assert.rejects(empty.getAccount(), (err) => {
    assert.equal(err.code, 'invalid_response')
    return true
  })
})

test('createTopup POSTs the amount as a JSON body and returns the intent', async () => {
  const calls = []
  const client = createBillingClient({
    fetchFn: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(201, {
        payment_intent_id: 9, invoice_url: 'https://pay.example/i/9', expires_at: '2026-10-10T01:00:00Z',
      })
    },
  })
  const intent = await client.createTopup('5')
  assert.equal(calls[0].url, '/api/v1/billing/topup')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  // The web form asks for the hosted-invoice shape explicitly.
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    amount_usd: '5',
    mode: 'invoice',
  })
  assert.equal(intent.payment_intent_id, 9)
})

test('createTopup surfaces the closed switch as topup_closed', async () => {
  const client = createBillingClient({
    fetchFn: async () => jsonResponse(503, { detail: { error: 'topup_closed' } }),
  })
  await assert.rejects(client.createTopup('5'), (err) => {
    assert.equal(err.status, 503)
    assert.equal(err.code, 'topup_closed')
    return true
  })
})

// ── desktop branch: bridge only, never /api/v1 ───────────

const DESKTOP_ACCOUNT = {
  billing_id: 'd_1', kind: 'human', status: 'active', balance_usd: '3.25',
  plan: 'payg', period_end: null, included_storage_bytes: 0, open_slabs: 0,
  allowance_egress_bytes: 0, egress_used_bytes: 0, days_left: null,
  topup_url: 'https://tessera.storage/account', topup_open: false, warnings: [],
}

function explodingFetch(counter) {
  return async () => {
    counter.calls += 1
    throw new Error('desktop must never fetch /api/v1')
  }
}

test('desktop getAccount uses the injected bridge and makes zero fetch calls', async () => {
  const counter = { calls: 0 }
  const client = createBillingClient({
    isDesktop: true,
    bridge: { getAccount: async () => DESKTOP_ACCOUNT },
    fetchFn: explodingFetch(counter),
  })
  assert.equal(client.isDesktop(), true)
  const acct = await client.getAccount()
  assert.equal(acct.billing_id, 'd_1')
  assert.equal(counter.calls, 0)
})

test('desktop getAccount accepts the {ok, data} bridge envelope', async () => {
  const counter = { calls: 0 }
  const client = createBillingClient({
    isDesktop: true,
    bridge: { getAccount: async () => ({ ok: true, data: DESKTOP_ACCOUNT }) },
    fetchFn: explodingFetch(counter),
  })
  const acct = await client.getAccount()
  assert.equal(acct.billing_id, 'd_1')
  assert.equal(counter.calls, 0)
})

test('desktop getAccount accepts the {ok, ...account} IPC spread shape', async () => {
  const counter = { calls: 0 }
  const client = createBillingClient({
    isDesktop: true,
    bridge: { getAccount: async () => ({ ok: true, ...DESKTOP_ACCOUNT }) },
    fetchFn: explodingFetch(counter),
  })
  const acct = await client.getAccount()
  assert.equal(acct.billing_id, 'd_1')
  assert.equal(acct.ok, undefined)
  assert.equal(counter.calls, 0)
})

test('desktop without a bridge fails as desktop_bridge_unavailable, still no fetch', async () => {
  const counter = { calls: 0 }
  const client = createBillingClient({
    isDesktop: true, bridge: null, fetchFn: explodingFetch(counter),
  })
  await assert.rejects(client.getAccount(), (err) => {
    assert.ok(err instanceof BillingApiError)
    assert.equal(err.status, 0)
    assert.equal(err.code, 'desktop_bridge_unavailable')
    return true
  })
  assert.equal(counter.calls, 0)
})

test('desktop bridge no-credential envelope maps to its code, still no fetch', async () => {
  const counter = { calls: 0 }
  const client = createBillingClient({
    isDesktop: true,
    bridge: { getAccount: async () => ({ ok: false, code: 'no_credentials', error: 'no billing credentials' }) },
    fetchFn: explodingFetch(counter),
  })
  await assert.rejects(client.getAccount(), (err) => {
    assert.equal(err.code, 'no_credentials')
    return true
  })
  assert.equal(counter.calls, 0)
})

test('desktop bridge throw maps to desktop_bridge_error, still no fetch', async () => {
  const counter = { calls: 0 }
  const client = createBillingClient({
    isDesktop: true,
    bridge: { getAccount: async () => { throw new Error('spawn failed') } },
    fetchFn: explodingFetch(counter),
  })
  await assert.rejects(client.getAccount(), (err) => {
    assert.equal(err.code, 'desktop_bridge_error')
    return true
  })
  assert.equal(counter.calls, 0)
})

test('desktop createTopup rejects as desktop_topup_unsupported without any fetch call', async () => {
  const counter = { calls: 0 }
  const client = createBillingClient({
    isDesktop: true,
    bridge: { getAccount: async () => DESKTOP_ACCOUNT },
    fetchFn: explodingFetch(counter),
  })
  await assert.rejects(client.createTopup('5'), (err) => {
    assert.equal(err.code, 'desktop_topup_unsupported')
    return true
  })
  assert.equal(counter.calls, 0)
})

test('isDesktop may be a predicate and defaults to web when absent', async () => {
  let desktop = false
  const calls = []
  const client = createBillingClient({
    isDesktop: () => desktop,
    bridge: { getAccount: async () => DESKTOP_ACCOUNT },
    fetchFn: async (url) => { calls.push(url); return jsonResponse(200, { billing_id: 'web' }) },
  })
  const web = await client.getAccount()
  assert.equal(web.billing_id, 'web')
  assert.equal(calls.length, 1)
  desktop = true
  const bridged = await client.getAccount()
  assert.equal(bridged.billing_id, 'd_1')
  assert.equal(calls.length, 1)
})

// ── secrets hygiene ──────────────────────────────────────

test('billing.js never logs or writes storage at module level', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  assert.ok(!source.includes('console.'), 'billing.js must not log')
  assert.ok(!source.includes('localStorage'), 'billing.js must not touch localStorage')
  assert.ok(!source.includes('sessionStorage'), 'billing.js must not touch sessionStorage')
  assert.ok(!source.includes('document.cookie'), 'billing.js must never read the session cookie')
})

test('toNumber coerces API shapes', () => {
  assert.equal(toNumber(3), 3)
  assert.equal(toNumber('3.5'), 3.5)
  assert.equal(toNumber(''), null)
  assert.equal(toNumber('abc'), null)
  assert.equal(toNumber(NaN), null)
  assert.equal(toNumber(Infinity), null)
  assert.equal(toNumber(null), null)
})
