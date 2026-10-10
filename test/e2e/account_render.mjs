// Task 8 E2E — render the live /api/v1/account payload with the real
// packages/shared/src/billing.js client + view.
//
// createBillingClient fetches the account through the temp proxy with the
// same-origin session cookie; createBillingView builds the account screen
// against a minimal detached-DOM shim (createElement / textContent /
// appendChild / setAttribute / style), then the rendered text is asserted.
// No monetized data, cookie, or key material is printed beyond the account
// fields the UI itself displays.

import {
  createBillingClient,
  createBillingView,
} from '../../packages/shared/src/billing.js'

const apiBase = process.env.TESSERA_E2E_API_BASE
const cookie = process.env.TESSERA_E2E_COOKIE || ''

function fail(label) {
  process.stdout.write(`FAIL ${label}\n`)
  process.exit(1)
}

function check(condition, label) {
  if (condition) process.stdout.write(`PASS ${label}\n`)
  else fail(label)
}

function cookieFetch(url, init = {}) {
  const headers = { ...(init.headers || {}) }
  if (cookie) headers.Cookie = cookie
  if (apiBase) headers.Origin = apiBase
  return fetch(url, { ...init, headers })
}

class El {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.attrs = {}
    this.style = {}
    this.className = ''
    this.ownText = null
  }

  appendChild(child) {
    this.children.push(child)
    return child
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }

  addEventListener() {}

  get textContent() {
    if (this.children.length) {
      return this.children.map((child) => child.textContent || '').join(' ')
    }
    return this.ownText === null ? '' : this.ownText
  }

  set textContent(value) {
    this.ownText = String(value)
    this.children = []
  }
}

const doc = {
  createElement: (tag) => new El(tag),
  createTextNode: (text) => ({
    textContent: String(text),
    children: [],
    appendChild() {},
    setAttribute() {},
    style: {},
  }),
}

const client = createBillingClient({ fetchFn: cookieFetch, apiBase })
const account = await client.getAccount()
process.stdout.write(
  `account_payload status=${account.status} plan=${account.plan} ` +
    `balance_usd=${account.balance_usd} kind=${account.kind}\n`,
)

const view = createBillingView({ doc, client, desktop: false })
view.showAccount(account)
const rendered = view.el.textContent.replace(/\s+/g, ' ').trim()
process.stdout.write(`render_text=${rendered}\n`)

check(account.plan === 'payg', 'payload-plan-payg')
check(Number(account.balance_usd) === 25, 'payload-balance-25')
check(account.status === 'active', 'payload-status-active')
check(rendered.includes('Balance'), 'render-has-Balance')
check(rendered.includes('$25.00'), 'render-has-dollar25')
check(rendered.includes('Plan'), 'render-has-Plan')
check(rendered.includes('Pay as you go'), 'render-has-payg-label')
check(rendered.includes('Active'), 'render-has-active-badge')
check(rendered.includes('Account ID'), 'render-has-account-id')
process.stdout.write('account_render=ok\n')
