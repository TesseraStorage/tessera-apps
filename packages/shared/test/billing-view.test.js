// @tessera/shared — billing view DOM-shim smoke test (P6 Task 3, Decision 3)
//
// The repo has no jsdom and Task 3 adds no dependencies, so this file brings
// a minimal document shim (createElement/createTextNode/textContent/
// appendChild/setAttribute/addEventListener) and renders the real view module
// against it. It asserts what the DOM ends up containing: every Decision 3
// field, the closed top-up copy, the sign-in copy on 401, and the desktop
// link-instead-of-form branch. The structural block at the bottom guards the
// web-ui.js wiring (ids declared/cached, screen toggle, client + view hooks).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BILLING_SIGN_IN_URL, BillingApiError, createBillingView,
} from '../src/billing.js'

const WEB_UI = readFileSync(fileURLToPath(new URL('../src/web-ui.js', import.meta.url)), 'utf8')

// ── minimal DOM shim ─────────────────────────────────────

function createElement(doc, tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    id: '',
    type: '',
    value: '',
    href: '',
    target: '',
    rel: '',
    disabled: false,
    style: {},
    children: [],
    parentNode: null,
    attributes: {},
    _listeners: {},
    _text: '',
    ownerDocument: doc,
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      return node._text + node.children.map((c) => c.textContent).join('')
    },
    set(value) {
      node._text = value == null ? '' : String(value)
      node.children = []
    },
  })
  node.appendChild = (child) => {
    node.children.push(child)
    child.parentNode = node
    return child
  }
  node.setAttribute = (key, value) => {
    node.attributes[key] = String(value)
    if (key === 'id') node.id = String(value)
  }
  node.getAttribute = (key) => (key in node.attributes ? node.attributes[key] : null)
  node.addEventListener = (type, fn) => {
    if (!node._listeners[type]) node._listeners[type] = []
    node._listeners[type].push(fn)
  }
  node.fire = (type) => {
    const event = {
      type,
      target: node,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
    }
    for (const fn of node._listeners[type] || []) fn(event)
    return event
  }
  return node
}

function createDocument() {
  const doc = {}
  doc.createElement = (tag) => createElement(doc, tag)
  doc.createTextNode = (text) => {
    const node = createElement(doc, '#text')
    node._text = String(text)
    return node
  }
  return doc
}

function walk(node, out = []) {
  out.push(node)
  for (const child of node.children) walk(child, out)
  return out
}

const all = (root, pred) => walk(root).filter(pred)
const byTag = (root, tag) => all(root, (n) => n.tagName === tag.toUpperCase())
const byText = (root, needle) => all(root, (n) => n.children.length === 0 && n.textContent.includes(needle))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── fixtures ─────────────────────────────────────────────

const ACCOUNT = {
  billing_id: 'b_123',
  kind: 'human',
  status: 'active',
  balance_usd: 12.5,
  plan: 'starter',
  period_end: '2026-11-01T00:00:00Z',
  included_storage_bytes: 5_000_000_000,
  network_bytes: 6_000_000_000,
  raw_bytes: 2_000_000_000,
  open_slabs: 3,
  allowance_egress_bytes: 10_000_000_000,
  egress_used_bytes: 1_000_000_000,
  days_left: 5,
  topup_url: 'https://tessera.storage/account',
  topup_open: false,
  warnings: [
    { kind: 'warning_7', days_left: 7, balance_usd: '4.00', sent_at: '2026-10-08T12:00:00Z', delivered_at: null },
  ],
}

// ── full dashboard, closed top-up ────────────────────────

test('closed top-up renders every Decision 3 field and no form', () => {
  const doc = createDocument()
  const view = createBillingView({ doc })
  view.showAccount(ACCOUNT)
  const text = view.el.textContent

  assert.match(text, /\$12\.50/)                      // balance
  assert.match(text, /Starter/)                       // plan
  assert.match(text, /Active/)                        // status
  assert.match(text, /5 days/)                        // days left
  assert.match(text, /Nov 1, 2026|1 Nov 2026/)        // period end (locale-tolerant)
  assert.match(text, /Your files/)                    // raw file weight row
  assert.match(text, /2\.00 GB/)                      // raw_bytes
  assert.match(text, /Network size/)                  // network total row
  assert.match(text, /6\.00 GB/)                      // network_bytes
  assert.match(text, /5\.00 GB/)                      // included storage
  assert.match(text, /1\.00 GB of 10\.0 GB/)          // egress used/allowance
  assert.match(text, /7 days of balance remaining/)   // warning label
  assert.match(text, /Human/)                         // kind
  assert.match(text, /b_123/)                         // billing_id
  assert.match(text, /Top-up is not yet open/)        // closed switch

  assert.equal(byTag(view.el, 'form').length, 0, 'closed top-up must render no form')
  assert.equal(byTag(view.el, 'input').length, 0, 'closed top-up must render no input')

  const topupLink = byTag(view.el, 'a').find((a) => a.href === ACCOUNT.topup_url)
  assert.ok(topupLink, 'topup_url must be rendered as a link')
})

test('warnings empty state and egress bar follow the account data', () => {
  const doc = createDocument()
  const view = createBillingView({ doc })
  view.showAccount({ ...ACCOUNT, warnings: [], egress_used_bytes: 12_000_000_000 })
  assert.match(view.el.textContent, /Nothing to act on/)
  assert.match(view.el.textContent, /Over the included allowance/)
  const fill = all(view.el, (n) => n.className.includes('billing-bar-fill'))[0]
  assert.ok(fill, 'egress bar expected when the allowance is known')
  assert.equal(fill.style.width, '100%')
})

test('a notice banner appears for pending/active statuses that need one', () => {
  const doc = createDocument()
  const view = createBillingView({ doc })
  view.showAccount({ ...ACCOUNT, status: 'pending' })
  assert.match(view.el.textContent, /Storage is paused until the first top-up/)
  view.showAccount({ ...ACCOUNT, status: 'active' })
  assert.ok(!view.el.textContent.includes('Storage is paused'))
})

// ── open top-up ──────────────────────────────────────────

test('topup_open true renders the form and submits through the client', async () => {
  const calls = []
  const client = {
    createTopup: async (amount) => {
      calls.push(amount)
      return {
        payment_intent_id: 9,
        invoice_url: 'https://pay.example/i/9',
        expires_at: '2026-10-10T01:00:00Z',
      }
    },
  }
  const doc = createDocument()
  const view = createBillingView({ doc, client })
  view.showAccount({ ...ACCOUNT, topup_open: true })

  const form = byTag(view.el, 'form')[0]
  assert.ok(form, 'open top-up must render the form')
  const input = byTag(view.el, 'input')[0]
  assert.ok(input, 'the form must carry the amount input')
  input.value = '25'

  const event = form.fire('submit')
  assert.equal(event.defaultPrevented, true)
  await tick()

  assert.deepEqual(calls, ['25'])
  assert.match(view.el.textContent, /Invoice ready/)
  const invoice = byTag(view.el, 'a').find((a) => a.href === 'https://pay.example/i/9')
  assert.ok(invoice, 'the invoice URL must be rendered as a link')
  assert.match(view.el.textContent, /Start another top-up/)
})

test('top-up validation rejects below the $0.01 minimum before any call', async () => {
  const calls = []
  const client = { createTopup: async (amount) => { calls.push(amount); return {} } }
  const doc = createDocument()
  const view = createBillingView({ doc, client })
  view.showAccount({ ...ACCOUNT, topup_open: true })
  const input = byTag(view.el, 'input')[0]
  input.value = '0.001'
  byTag(view.el, 'form')[0].fire('submit')
  await tick()
  assert.deepEqual(calls, [])
  assert.match(view.el.textContent, /Enter an amount of \$0\.01 or more\./)
})

test('a 503 topup_closed from the server shows the closed copy, not a crash', async () => {
  const client = {
    createTopup: async () => {
      throw new BillingApiError(503, { detail: { error: 'topup_closed' } })
    },
  }
  const doc = createDocument()
  const view = createBillingView({ doc, client })
  view.showAccount({ ...ACCOUNT, topup_open: true })
  byTag(view.el, 'form')[0].fire('submit')
  await tick()
  assert.match(view.el.textContent, /Public top-ups are not open yet/)
})

// ── signed out / desktop / errors ────────────────────────

test('401 state renders "sign in at tessera.storage/account" with the link', () => {
  const doc = createDocument()
  const view = createBillingView({ doc })
  view.showSignedOut()
  assert.match(view.el.textContent, /sign in at tessera\.storage\/account/i)
  const link = byTag(view.el, 'a').find((a) => a.href === BILLING_SIGN_IN_URL)
  assert.ok(link, 'the sign-in link must point at the account page')
})

test('desktop (canTopup false) links to topup_url instead of the form', () => {
  const doc = createDocument()
  const view = createBillingView({ doc, canTopup: false })
  view.showAccount({ ...ACCOUNT, topup_open: true })
  assert.equal(byTag(view.el, 'form').length, 0)
  assert.match(view.el.textContent, /Top up on the web/)
  const link = byTag(view.el, 'a').find((a) => a.href === ACCOUNT.topup_url)
  assert.ok(link)
})

test('desktop "no credential" state and retryable load error render distinctly', () => {
  const doc = createDocument()
  let retries = 0
  const view = createBillingView({ doc, onRetry: () => { retries += 1 } })
  view.showDesktopUnavailable()
  assert.match(view.el.textContent, /tessera login/)
  view.showError('The account service did not answer.')
  assert.match(view.el.textContent, /Could not load the account/)
  const retry = byTag(view.el, 'button')[0]
  retry.fire('click')
  assert.equal(retries, 1)
})

test('Bug 7: desktop APP wording never tells the user to run a CLI command', () => {
  const doc = createDocument()
  const view = createBillingView({ doc, desktop: true })
  view.showDesktopUnavailable()
  assert.match(view.el.textContent, /Sign in from the Welcome screen/)
  assert.ok(!/tessera login/.test(view.el.textContent), 'desktop app copy must not reference the CLI')
})

test('showLoading then showAccount replaces the content', () => {
  const doc = createDocument()
  const view = createBillingView({ doc })
  view.showLoading()
  assert.match(view.el.textContent, /Loading account/)
  view.showAccount(ACCOUNT)
  assert.ok(!view.el.textContent.includes('Loading account'))
  assert.match(view.el.textContent, /\$12\.50/)
})

// ── web-ui.js wiring (structural, mirrors web-ui-handoff.test.js) ──

test('every billing DOM id is declared in the skeleton and cached in cacheRefs', () => {
  const cacheBlock = WEB_UI.slice(
    WEB_UI.indexOf('function cacheRefs()'),
    WEB_UI.indexOf('for (const id of ids)'),
  )
  for (const id of ['btnBilling', 'billingScreen', 'billingBody', 'btnBillingBack']) {
    assert.ok(cacheBlock.includes(`'${id}'`), `cacheRefs is missing '${id}'`)
    assert.ok(WEB_UI.includes(`id="${id}"`), `skeleton is missing id="${id}"`)
  }
})

test('billingScreen is toggled with the other screens', () => {
  assert.ok(WEB_UI.includes("r.billingScreen.classList.toggle('hidden', s !== 'billing')"))
})

test('billing screen is wired to the shared client and view, desktop hook included', () => {
  assert.ok(WEB_UI.includes("r.btnBilling.addEventListener('click', onShowBilling)"))
  assert.ok(WEB_UI.includes("r.btnBillingBack.addEventListener('click', () => history.back())"))
  assert.ok(WEB_UI.includes('billingClient = createBillingClient({})'))
  assert.ok(WEB_UI.includes('billingView = createBillingView({'))
  assert.ok(WEB_UI.includes('canTopup: !isDesktop()'))
  assert.ok(WEB_UI.includes('desktop: isDesktop()'))
  assert.ok(WEB_UI.includes('billingView.showSignedOut()'))
  assert.ok(WEB_UI.includes('billingView.showDesktopUnavailable()'))
  assert.ok(WEB_UI.includes("if (screen === 'billing') loadBilling()"))
  assert.ok(WEB_UI.includes("from './billing.js'"))
})
