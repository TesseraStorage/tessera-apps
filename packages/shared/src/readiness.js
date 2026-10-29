// Transfer readiness (2026-10-29, "agent-readiness").
//
// A new account can try to upload before its host funding lands (Tessera
// posts a free-first-upload credit and funds hosts a few seconds after the
// first host-list fetch). The client may also sit on a network that cannot
// reach enough hosts, or the account may simply be out of funds. The SDK
// reports all three the same way ("no more hosts available", "not enough
// shards", or this app's stall watchdog), so that error must never reach the
// user as-is.
//
// withTransferReadiness() runs a transfer and, on a host-shortage error, waits
// and retries while funding may still be landing. It shows a waiting message
// and finally names the cause:
//   insufficient_balance  balance is $0 after a grace period
//   hosts_unreachable     the account is funded, but fewer than the needed
//                         hosts could be reached from this network
//   account_not_ready     funding did not land within the wait
// The `Ready` flag is deliberately NOT a gate: it tracks repair-redundancy
// funding, and a free account keeps Ready:false until its first paid top-up
// even though its first upload works.

export const UPLOAD_HOSTS_NEEDED = 30
export const DOWNLOAD_HOSTS_NEEDED = 10
export const READINESS_MAX_WAIT_MS = 120000
export const READINESS_POLL_MS = 5000
export const READINESS_BALANCE_GRACE_MS = 30000
export const READINESS_WAITING_TEXT = 'Waiting for your account to be ready\u2026'

const SHORTAGE_PATTERNS = [
  'no more hosts',
  'not enough hosts',
  'not enough shards',
  'too few shards',
  'insufficient shard',
  'could not reach storage hosts',
]

/** True when an error is the SDK's (or this app's) "not enough hosts" signal. */
export function isHostShortageError(e) {
  if (!e || e.readiness) return false
  const msg = String((e && e.message) || e || '').toLowerCase()
  return SHORTAGE_PATTERNS.some(p => msg.includes(p))
}

export class TransferReadinessError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TransferReadinessError'
    this.code = code
    this.readiness = true
  }
}

export function readinessMessage(code, op = 'upload') {
  const needed = op === 'upload' ? UPLOAD_HOSTS_NEEDED : DOWNLOAD_HOSTS_NEEDED
  switch (code) {
    case 'insufficient_balance':
      return 'Insufficient balance: your account has no funds for storage hosts. Add funds and try again: from $0.01 with an x402 wallet (USDC on Base), or from about $0.38 by crypto checkout (the minimum depends on the coin).'
    case 'hosts_unreachable':
      return 'Your account is funded, but fewer than the ' + needed + ' storage hosts a ' + op +
        ' needs could be reached from this network. A firewall, VPN, proxy or restricted network may be blocking them. Try another network.'
    default:
      return 'Your account is not ready yet: storage host funding has not landed. New accounts are usually ready within a minute; try again shortly.'
  }
}

/** Parses balance_usd (string or number); null when unknown. */
export function parseBalanceUSD(acct) {
  if (!acct || acct.balance_usd === undefined || acct.balance_usd === null) return null
  const n = Number(acct.balance_usd)
  return Number.isFinite(n) ? n : null
}

/**
 * Runs fn(); on a host-shortage error waits and retries, then throws a
 * TransferReadinessError naming the cause. Non-shortage errors pass through.
 *
 * opts:
 *   op            'upload' | 'download'
 *   getBalanceUSD async () => number|null (null/throw = unknown, never blocks)
 *   onWaiting     ({ elapsedMs, attempt, text }) => void
 *   maxWaitMs, pollMs, graceMs, sleep, now   (tests)
 */
export async function withTransferReadiness(fn, opts = {}) {
  const op = opts.op === 'download' ? 'download' : 'upload'
  const maxWaitMs = opts.maxWaitMs ?? READINESS_MAX_WAIT_MS
  const pollMs = opts.pollMs ?? READINESS_POLL_MS
  const graceMs = opts.graceMs ?? READINESS_BALANCE_GRACE_MS
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)))
  const now = opts.now || (() => Date.now())
  const getBalance = async () => {
    if (!opts.getBalanceUSD) return null
    try { return await opts.getBalanceUSD() } catch (_) { return null }
  }
  const start = now()
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      if (!isHostShortageError(e)) throw e
      const balance = await getBalance()
      const elapsed = now() - start
      if (balance !== null && balance <= 0 && elapsed >= graceMs) {
        throw new TransferReadinessError('insufficient_balance', readinessMessage('insufficient_balance', op))
      }
      if (elapsed + pollMs > maxWaitMs) {
        const code = balance !== null && balance > 0 ? 'hosts_unreachable' : 'account_not_ready'
        throw new TransferReadinessError(code, readinessMessage(code, op))
      }
      if (opts.onWaiting) {
        try { opts.onWaiting({ elapsedMs: elapsed, attempt, text: READINESS_WAITING_TEXT }) } catch (_) {}
      }
      await sleep(pollMs)
    }
  }
}

/** Packed uploads report per-file errors; treat "all failed for lack of hosts" as a shortage. */
export function packedShortageError(results) {
  if (!Array.isArray(results) || !results.length) return null
  if (results.some(r => r && r.ok)) return null
  const shortage = results.find(r => r && isHostShortageError(new Error(String(r.error || ''))))
  return shortage && results.every(r => r && !r.ok && (isHostShortageError(new Error(String(r.error || ''))) || /empty files/i.test(String(r.error || ''))))
    ? new Error(String(shortage.error))
    : null
}
