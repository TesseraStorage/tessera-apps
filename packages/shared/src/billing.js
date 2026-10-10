// @tessera/shared — billing semantics + account view (P6 Task 3, Decision 3)
//
// Ported from Tessera-FE:
//   app/composables/useBilling.ts  — API client + error shape
//   app/utils/billing-format.ts    — display helpers
//   app/pages/account.vue          — rendered fields, status labels/copy
//   app/components/BillingTopupForm.vue — top-up form + error copy
//
// The browser's only door to the billing service is relative, same-origin
// `/api/v1` URLs with the ambient `tessera_session` cookie
// (`credentials: 'same-origin'`); the site is served by the same nginx vhost
// that proxies `/api/v1` to moneyd, so there is no CORS and no API host baked
// into code.
//
// DESKTOP (Decision 3/6): Electron never fetches `/api/v1`. On desktop
// `createBillingClient().getAccount()` answers through an injected bridge
// (`window.tesseraDesktop.billingAccount`, implemented by Task 6 from the
// bundled CLI's `tessera account --json`); the desktop branch makes no
// `fetch` call at all. Top-up creation is web-only — the desktop panel links
// to `topup_url` instead (top-up form hidden anyway unless topup_open).
//
// SECRETS: this module never logs. The session cookie is ambient (the browser
// attaches it; this code never reads it) and no session/key material is ever
// written to storage, URLs, or diagnostics.

export const BILLING_SIGN_IN_URL = 'https://tessera.storage/account'

/** 401 copy demanded by Decision 3; the exact phrase is load-bearing. */
export const BILLING_SIGNED_OUT_MESSAGE =
  'Sign in at tessera.storage/account to see your balance and usage.'

/** Decision 6: desktop with no stored billing credential. */
export const BILLING_DESKTOP_MESSAGE =
  'No billing credential on this machine. Run `tessera login` and try again.'

export const TOPUP_MIN_USD = 5
export const TOPUP_MAX_USD = 10000

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

// ── display helpers (billing-format.ts port) ─────────────
//
// Byte formatting is decimal (1 TB = 10^12 bytes) on purpose: that is the
// unit every price is quoted in, so an allowance of "1 TB" here always means
// the same thing as "$8 per TB" on the pricing page.

/** Coerce API values (number, numeric string, null) to a finite number. */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function formatUsd(value) {
  const amount = toNumber(value)
  return amount === null ? '—' : USD.format(amount)
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value <= 0) return '0 B'
  let amount = value
  let unit = 0
  while (amount >= 1000 && unit < BYTE_UNITS.length - 1) {
    amount /= 1000
    unit += 1
  }
  const digits = unit === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2
  return `${amount.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

export function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatDaysLeft(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value <= 0) return 'No days'
  return value === 1 ? '1 day' : `${value} days`
}

export function formatPlan(value) {
  if (!value) return '—'
  const known = {
    payg: 'Pay as you go',
    starter: 'Starter',
    enterprise: 'Enterprise',
  }
  return known[value] ?? value
}

export function warningLabel(kind) {
  const known = {
    warning_7: '7 days of balance remaining',
    warning_3: '3 days of balance remaining',
    warning_1: '1 day of balance remaining',
    warning_0: 'Balance exhausted',
  }
  return known[kind] ?? String(kind || '').replace(/_/g, ' ')
}

/** Percentage of an allowance used, clamped to 0–100, or null when unknown. */
export function usedPercent(used, allowance) {
  if (
    used == null ||
    allowance == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(allowance) ||
    allowance <= 0
  ) {
    return null
  }
  return Math.min(100, Math.max(0, (used / allowance) * 100))
}

export const ACCOUNT_STATUS_LABELS = Object.freeze({
  pending: 'Awaiting first payment',
  active: 'Active',
  past_due: 'Past due',
  suspended: 'Suspended',
  terminated: 'Terminated',
})

export function accountStatusLabel(status) {
  if (!status) return '—'
  return ACCOUNT_STATUS_LABELS[status] ?? status
}

export function accountKindLabel(kind) {
  if (!kind) return '—'
  if (kind === 'human') return 'Human'
  if (kind === 'agent') return 'Agent'
  return kind
}

/**
 * account.vue's statusNotice: the banner shown above the dashboard. Copy is
 * ported verbatim; the FE interpolates its contact email, so that one spot
 * takes `supportEmail` (default info@tessera.storage).
 */
export function accountStatusNotice(status, topupOpen, opts = {}) {
  const supportEmail = opts.supportEmail || 'info@tessera.storage'
  switch (status) {
    case 'pending':
      return topupOpen
        ? 'Storage is paused until the first top-up is confirmed. Top up below to activate the account.'
        : 'Storage is paused until the first top-up is confirmed. Public top-ups are not yet open; activation follows the first confirmed payment.'
    case 'past_due':
      return topupOpen
        ? 'The balance no longer covers the plan fee. Top up during the grace window to renew the period.'
        : `The balance no longer covers the plan fee. Public top-ups are not yet open — contact ${supportEmail}.`
    case 'suspended':
      return 'The account is suspended and storage is paused. Contact us if you believe this is a mistake.'
    case 'terminated':
      return 'This account is terminated. Contact us if you believe this is a mistake.'
    default:
      return null
  }
}

// ── API client (useBilling.ts port) ──────────────────────

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/**
 * Most moneyd errors nest their machine-readable code under `detail`
 * (`{"detail":{"error":"…"}}`); `POST /auth/verify` answers 401 with a flat
 * `{"error":"invalid_token"}`. Both shapes resolve to the same `code`.
 */
export function errorCode(payload) {
  if (!isRecord(payload)) return null
  if (typeof payload.error === 'string') return payload.error
  const detail = payload.detail
  if (typeof detail === 'string') return detail
  if (isRecord(detail) && typeof detail.error === 'string') return detail.error
  return null
}

export class BillingApiError extends Error {
  constructor(status, payload) {
    const code = errorCode(payload)
    super(code ? `${code} (HTTP ${status})` : `HTTP ${status}`)
    this.name = 'BillingApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }

  /** The nested `detail` object when the error shape carries one. */
  get detail() {
    return isRecord(this.payload) && isRecord(this.payload.detail)
      ? this.payload.detail
      : null
  }
}

function joinUrl(base, path) {
  return (base ? String(base).replace(/\/+$/, '') : '') + path
}

// Desktop is detected the same way web-ui.js/FETCH_MODE() do it: the preload
// bridge sets window.tesseraDesktop.isDesktop. A `bridge` may also be passed
// explicitly (Task 6 / tests), which bypasses the global entirely.
function defaultIsDesktop() {
  return typeof window !== 'undefined' &&
    !!(window.tesseraDesktop && window.tesseraDesktop.isDesktop)
}

function defaultDesktopBridge() {
  if (
    typeof window !== 'undefined' &&
    window.tesseraDesktop &&
    typeof window.tesseraDesktop.billingAccount === 'function'
  ) {
    return { getAccount: () => window.tesseraDesktop.billingAccount() }
  }
  return null
}

/**
 * Client-only billing calls (same shape as FE `useBilling()`, narrowed to the
 * account surface this task renders). All methods are plain async functions;
 * keep their invocation inside event handlers / screen entry, never at module
 * import time.
 *
 * opts:
 *   fetchFn   injectable fetch (tests); defaults to globalThis.fetch
 *   apiBase   prefix for /api/v1 (default '' = same origin)
 *   isDesktop boolean or () => boolean; defaults to the preload flag
 *   bridge    desktop transport `{ getAccount() }`; defaults to
 *             window.tesseraDesktop.billingAccount
 */
export function createBillingClient(opts = {}) {
  const fetchFn = opts.fetchFn || ((...args) => globalThis.fetch(...args))
  const apiBase = opts.apiBase || ''
  const isDesktop = typeof opts.isDesktop === 'function'
    ? opts.isDesktop
    : () => opts.isDesktop !== undefined
      ? !!opts.isDesktop
      : defaultIsDesktop()
  const bridge = opts.bridge !== undefined ? opts.bridge : defaultDesktopBridge()

  async function request(path, init = {}) {
    const hasBody = init.body !== undefined

    const response = await fetchFn(joinUrl(apiBase, `/api/v1${path}`), {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(init.body) : undefined,
    })

    const text = await response.text()
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch (_) {
        payload = text
      }
    }

    if (!response.ok) throw new BillingApiError(response.status, payload)
    if (payload === null || typeof payload === 'string') {
      // A 2xx that is not JSON means something between the browser and
      // moneyd (a proxy, a cache, a captive portal) answered instead of the
      // API.
      throw new BillingApiError(response.status, {
        detail: { error: 'invalid_response' },
      })
    }
    return payload
  }

  // Desktop account over the CLI bridge. The IPC handler (Task 6) may answer
  // the account object directly, or wrap it as {ok, account|data, error,
  // code}. Every failure mode becomes a BillingApiError so callers only ever
  // handle one error type. This path never touches fetch.
  async function getAccountViaBridge() {
    if (!bridge || typeof bridge.getAccount !== 'function') {
      throw new BillingApiError(0, {
        detail: { error: 'desktop_bridge_unavailable' },
      })
    }
    let result
    try {
      result = await bridge.getAccount()
    } catch (e) {
      throw new BillingApiError(0, {
        detail: { error: 'desktop_bridge_error' },
      })
    }
    if (isRecord(result) && 'ok' in result) {
      if (!result.ok) {
        throw new BillingApiError(0, {
          detail: { error: result.code || 'desktop_bridge_error' },
        })
      }
      if (isRecord(result.account)) {
        result = result.account
      } else if (isRecord(result.data)) {
        result = result.data
      } else {
        // `{ok:true, ...account}` (the sia-account IPC shape) — everything
        // except the ok flag is the account object.
        const copy = { ...result }
        delete copy.ok
        result = Object.keys(copy).length ? copy : null
      }
    }
    if (!isRecord(result)) {
      throw new BillingApiError(0, {
        detail: { error: 'invalid_response' },
      })
    }
    return result
  }

  return {
    /** True when account data will come from the desktop bridge. */
    isDesktop,

    getAccount() {
      if (isDesktop()) return getAccountViaBridge()
      return request('/account')
    },

    /** Creates a hosted invoice; desktop has no session and never POSTs. */
    createTopup(amountUsd) {
      if (isDesktop()) {
        return Promise.reject(
          new BillingApiError(0, { detail: { error: 'desktop_bridge_unavailable' } }),
        )
      }
      return request('/billing/topup', {
        method: 'POST',
        body: { amount_usd: String(amountUsd) },
      })
    },
  }
}

// ── account view (account.vue + BillingTopupForm.vue port) ──
//
// Framework-free DOM builder so both the web app (web-ui.js) and the desktop
// shell (Task 6) render the same account. Every string that reaches the DOM
// is set via textContent, never innerHTML — server data is display-only.

function h(doc, tag, className, text) {
  const el = doc.createElement(tag)
  if (className) el.className = className
  if (text !== undefined && text !== null) el.textContent = String(text)
  return el
}

function field(doc, label, value, sub) {
  const card = h(doc, 'div', 'billing-card')
  card.appendChild(h(doc, 'p', 'billing-label', label))
  card.appendChild(h(doc, 'p', 'billing-value', value))
  if (sub) card.appendChild(h(doc, 'p', 'billing-sub', sub))
  return card
}

function callout(doc, tone, title, body) {
  const box = h(doc, 'div', `billing-callout billing-callout-${tone}`)
  if (title) box.appendChild(h(doc, 'p', 'billing-callout-title', title))
  if (body) box.appendChild(h(doc, 'p', 'billing-callout-body', body))
  return box
}

function describeTopupError(err) {
  if (!(err instanceof BillingApiError)) {
    return 'Network error — the request did not leave your browser. Check your connection and try again.'
  }
  if (err.status === 401) {
    return BILLING_SIGNED_OUT_MESSAGE
  }
  switch (err.code) {
    case 'below_asset_minimum': {
      const minimum = err.detail && err.detail.minimum_usd
      return `That amount is below the minimum for the selected asset${
        minimum ? ` ($${minimum})` : ''
      }.`
    }
    case 'amount_out_of_range':
      return 'That amount is outside the accepted range ($5 to $10,000).'
    case 'topup_closed':
      return 'Public top-ups are not open yet. They will be announced once crypto payment is live; your balance, plan and promo codes keep working as usual.'
    case 'payments_unconfigured':
      return 'Checkout is not switched on yet. Please try again later.'
    case 'processor_error':
      return 'The payment processor refused to open an invoice. Try again in a moment.'
    case 'desktop_bridge_unavailable':
    case 'desktop_bridge_error':
    case 'no_credentials':
      return BILLING_DESKTOP_MESSAGE
    default:
      return 'We could not start the checkout. Try again in a moment.'
  }
}

/**
 * Builds the account screen as a detached DOM subtree.
 *
 * opts:
 *   doc        document-like (defaults to the global document)
 *   client     createBillingClient() result; required only for the top-up form
 *   canTopup   false on desktop — when topup_open is true the view links to
 *              topup_url instead of rendering the invoice form
 *   onRetry    retry handler for the load-error state
 *   signInUrl  override for the 401 link (default BILLING_SIGN_IN_URL)
 *
 * Returns { el, showLoading, showAccount, showSignedOut,
 *           showDesktopUnavailable, showError }.
 */
export function createBillingView(opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null)
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('createBillingView needs a document')
  }
  const client = opts.client || null
  const canTopup = opts.canTopup !== false && !(opts.desktop === true)
  const signInUrl = opts.signInUrl || BILLING_SIGN_IN_URL
  const root = h(doc, 'div', 'billing')

  function clear() {
    root.textContent = ''
  }

  function signInLink() {
    const p = h(doc, 'p', 'billing-callout-body')
    p.appendChild(doc.createTextNode('Sign in at '))
    const a = h(doc, 'a', 'billing-link', 'tessera.storage/account')
    a.href = signInUrl
    p.appendChild(a)
    p.appendChild(doc.createTextNode(' to see your balance and usage.'))
    return p
  }

  function showLoading() {
    clear()
    root.appendChild(h(doc, 'p', 'billing-loading', 'Loading account…'))
  }

  function showAccount(account) {
    clear()
    const data = account || {}
    const topupOpen = data.topup_open === true

    const notice = accountStatusNotice(data.status, topupOpen)
    if (notice) {
      root.appendChild(callout(
        doc,
        data.status === 'pending' ? 'info' : 'warn',
        null,
        notice,
      ))
    }

    const grid = h(doc, 'div', 'billing-grid')
    grid.appendChild(field(
      doc, 'Balance', formatUsd(data.balance_usd),
      'Prepaid USD, debited as you store and read data.',
    ))
    const planCard = field(doc, 'Plan', formatPlan(data.plan))
    const badge = h(doc, 'span', `billing-badge billing-badge-${data.status || 'unknown'}`, accountStatusLabel(data.status))
    planCard.appendChild(badge)
    grid.appendChild(planCard)
    grid.appendChild(field(
      doc, 'Days left', formatDaysLeft(data.days_left),
      'Estimated from balance and current burn.',
    ))
    grid.appendChild(field(
      doc, 'Period ends', formatDateTime(data.period_end),
      data.period_end
        ? 'The current plan period runs to this date.'
        : 'No billing period on pay as you go.',
    ))
    root.appendChild(grid)

    const cols = h(doc, 'div', 'billing-cols')
    cols.appendChild(usageSection(data))
    cols.appendChild(warningsSection(data))
    root.appendChild(cols)

    root.appendChild(topupSection(data, topupOpen))

    const footer = h(doc, 'div', 'billing-footer')
    const idLine = h(doc, 'p', 'billing-footer-line')
    idLine.appendChild(doc.createTextNode('Account ID '))
    idLine.appendChild(h(doc, 'code', 'billing-code', data.billing_id || '—'))
    idLine.appendChild(doc.createTextNode(` · ${accountKindLabel(data.kind)}`))
    footer.appendChild(idLine)
    if (data.topup_url) {
      const link = h(doc, 'a', 'billing-link', 'Top-up page')
      link.href = data.topup_url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      footer.appendChild(link)
    }
    root.appendChild(footer)
  }

  function usageSection(data) {
    const section = h(doc, 'section', 'billing-section')
    section.appendChild(h(doc, 'h3', null, 'Usage'))
    const dl = h(doc, 'dl', 'billing-dl')
    dl.appendChild(dlRow('Included storage', formatBytes(toNumber(data.included_storage_bytes))))
    dl.appendChild(dlRow('Open slabs', data.open_slabs == null ? '—' : String(data.open_slabs)))
    const allowance = toNumber(data.allowance_egress_bytes)
    const used = toNumber(data.egress_used_bytes)
    dl.appendChild(dlRow(
      'Egress this period',
      allowance
        ? `${formatBytes(used)} of ${formatBytes(allowance)}`
        : `${formatBytes(used)} reported`,
    ))
    section.appendChild(dl)

    const percent = usedPercent(used, allowance)
    if (percent !== null) {
      const wrap = h(doc, 'div', 'billing-bar-wrap')
      const line = h(doc, 'div', 'billing-bar-line')
      line.appendChild(h(doc, 'span', null, 'Egress allowance used'))
      line.appendChild(h(doc, 'span', 'billing-bar-pct', `${Math.round(percent)}%`))
      wrap.appendChild(line)
      const track = h(doc, 'div', 'billing-bar')
      const fill = h(doc, 'div', `billing-bar-fill${percent >= 100 ? ' over' : ''}`)
      fill.style.width = `${percent}%`
      fill.setAttribute('style', `width:${percent}%`)
      track.appendChild(fill)
      wrap.appendChild(track)
      if (percent >= 100) {
        wrap.appendChild(h(
          doc, 'p', 'billing-over',
          'Over the included allowance — further egress is metered at $5/TB.',
        ))
      }
      section.appendChild(wrap)
    }

    if (!allowance) {
      section.appendChild(h(
        doc, 'p', 'billing-note',
        'Pay-as-you-go accounts have no included egress; reads are metered at $5/TB.',
      ))
    }
    section.appendChild(h(
      doc, 'p', 'billing-note',
      'Storage is metered per open slab-day and egress per slab served; ingress is free. Reads are reported by the client, so this figure can lag slightly.',
    ))
    return section
  }

  function dlRow(label, value) {
    const row = h(doc, 'div', 'billing-dl-row')
    row.appendChild(h(doc, 'dt', null, label))
    row.appendChild(h(doc, 'dd', null, value))
    return row
  }

  function warningsSection(data) {
    const section = h(doc, 'section', 'billing-section')
    section.appendChild(h(doc, 'h3', null, 'Warnings'))
    const warnings = Array.isArray(data.warnings) ? data.warnings : []
    if (!warnings.length) {
      section.appendChild(h(
        doc, 'p', 'billing-note',
        'Nothing to act on. We email before the balance runs out, and every threshold warning also appears here.',
      ))
      return section
    }
    const ul = h(doc, 'ul', 'billing-warnings')
    warnings.forEach((warning) => {
      const li = h(doc, 'li', 'billing-warning')
      li.appendChild(h(doc, 'span', 'billing-warning-label', warningLabel(warning && warning.kind)))
      li.appendChild(h(doc, 'span', 'billing-warning-when', formatDateTime(warning && warning.sent_at)))
      ul.appendChild(li)
    })
    section.appendChild(ul)
    return section
  }

  function topupSection(data, topupOpen) {
    const section = h(doc, 'section', 'billing-section billing-topup')
    if (!topupOpen) {
      section.appendChild(h(doc, 'h3', null, 'Top-up is not yet open'))
      section.appendChild(h(
        doc, 'p', 'billing-note',
        'Public top-ups are not open yet. They will be announced once crypto payment is live; your balance, plan, usage and promo codes keep working as usual.',
      ))
      return section
    }

    if (!canTopup) {
      section.appendChild(h(doc, 'h3', null, 'Top up on the web'))
      section.appendChild(h(
        doc, 'p', 'billing-note',
        'Top-ups are created from your account page in a browser.',
      ))
      if (data.topup_url) {
        const link = h(doc, 'a', 'btn', 'Open account page')
        link.href = data.topup_url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        section.appendChild(link)
      }
      return section
    }

    section.appendChild(h(doc, 'h3', null, 'Top up balance'))
    section.appendChild(h(
      doc, 'p', 'billing-note',
      'Prepay a USD balance by crypto invoice. Usage is debited from it as you store and read data. The minimum top-up is $5.',
    ))

    const form = h(doc, 'form', 'billing-form')
    const label = h(doc, 'label', 'billing-label', 'Amount (USD)')
    label.setAttribute('for', 'billing-topup-amount')
    form.appendChild(label)
    const input = h(doc, 'input')
    input.id = 'billing-topup-amount'
    input.setAttribute('id', 'billing-topup-amount')
    input.type = 'number'
    input.setAttribute('type', 'number')
    input.value = '5'
    input.setAttribute('value', '5')
    input.setAttribute('inputmode', 'decimal')
    input.setAttribute('min', String(TOPUP_MIN_USD))
    input.setAttribute('max', String(TOPUP_MAX_USD))
    input.setAttribute('step', '0.01')
    form.appendChild(input)
    const error = h(doc, 'p', 'billing-error')
    error.setAttribute('role', 'alert')
    form.appendChild(error)
    const submit = h(doc, 'button', 'btn btn-primary', 'Open invoice')
    submit.type = 'submit'
    form.appendChild(submit)

    function reset() {
      form.textContent = ''
      buildForm()
    }

    function showInvoice(intent) {
      form.textContent = ''
      form.appendChild(callout(
        doc, 'good', 'Invoice ready',
        'Open the invoice and complete the payment. The balance updates when the payment confirms — refresh shortly after.',
      ))
      if (intent && intent.invoice_url) {
        const link = h(doc, 'a', 'billing-link', intent.invoice_url)
        link.href = intent.invoice_url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        form.appendChild(link)
      } else {
        form.appendChild(h(
          doc, 'p', 'billing-note',
          'No link returned — refresh the page and try again.',
        ))
      }
      if (intent && intent.expires_at) {
        form.appendChild(h(doc, 'p', 'billing-note', `Expires ${formatDateTime(intent.expires_at)}`))
      }
      const again = h(doc, 'button', 'btn', 'Start another top-up')
      again.type = 'button'
      again.addEventListener('click', reset)
      form.appendChild(again)
    }

    async function submitForm() {
      error.textContent = ''
      const amount = Number(input.value)
      if (!Number.isFinite(amount) || amount < TOPUP_MIN_USD) {
        error.textContent = 'Enter an amount of $5 or more.'
        return
      }
      if (amount > TOPUP_MAX_USD) {
        error.textContent = 'Enter an amount of $10,000 or less.'
        return
      }
      if (!client) {
        error.textContent = 'Checkout is not available right now. Please try again later.'
        return
      }
      submit.disabled = true
      submit.textContent = 'Opening invoice…'
      try {
        const intent = await client.createTopup(input.value)
        showInvoice(intent)
      } catch (err) {
        error.textContent = describeTopupError(err)
        submit.disabled = false
        submit.textContent = 'Open invoice'
      }
    }

    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      submitForm()
    })

    function buildForm() {
      form.appendChild(label)
      form.appendChild(input)
      form.appendChild(error)
      form.appendChild(submit)
    }

    section.appendChild(form)
    return section
  }

  function showSignedOut() {
    clear()
    const box = callout(doc, 'warn', 'Sign in required')
    box.appendChild(signInLink())
    root.appendChild(box)
  }

  function showDesktopUnavailable(message) {
    clear()
    root.appendChild(callout(
      doc, 'warn', 'Billing unavailable',
      message || BILLING_DESKTOP_MESSAGE,
    ))
  }

  function showError(message) {
    clear()
    const box = callout(
      doc, 'warn', 'Could not load the account',
      message || 'The account service did not answer. It may be temporarily unavailable.',
    )
    root.appendChild(box)
    if (typeof opts.onRetry === 'function') {
      const retry = h(doc, 'button', 'btn', 'Try again')
      retry.type = 'button'
      retry.addEventListener('click', () => opts.onRetry())
      root.appendChild(retry)
    }
  }

  return { el: root, showLoading, showAccount, showSignedOut, showDesktopUnavailable, showError }
}
