import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  withTransferReadiness, isHostShortageError, TransferReadinessError, packedShortageError, parseBalanceUSD,
} from '../src/readiness.js'

function clock() {
  let t = 0
  return { now: () => t, sleep: async ms => { t += ms } }
}
const shortage = () => { throw new Error('failed to upload: no more hosts available') }

test('isHostShortageError matches SDK and watchdog phrasings only', () => {
  assert.ok(isHostShortageError(new Error('no more hosts available')))
  assert.ok(isHostShortageError(new Error('Not enough shards: 12/30')))
  assert.ok(isHostShortageError(new Error('Could not reach storage hosts. Please try again.')))
  assert.ok(!isHostShortageError(new Error('Object not found')))
  assert.ok(!isHostShortageError(new TransferReadinessError('account_not_ready', 'no more hosts')))
})

test('waits while funding lands, then succeeds', async () => {
  const c = clock(); let n = 0; const waits = []
  const out = await withTransferReadiness(() => { if (++n < 3) shortage(); return 'ok' },
    { ...c, getBalanceUSD: async () => 0, onWaiting: w => waits.push(w.text) })
  assert.equal(out, 'ok'); assert.equal(n, 3); assert.equal(waits.length, 2)
  assert.match(waits[0], /Waiting for your account to be ready/)
})

test('zero balance after the grace period is insufficient balance', async () => {
  const c = clock()
  await assert.rejects(withTransferReadiness(shortage, { ...c, getBalanceUSD: async () => 0 }),
    e => e.readiness && e.code === 'insufficient_balance' && /from \$0\.01 with an x402 wallet/.test(e.message) && /crypto checkout/.test(e.message))
  assert.ok(c.now() >= 30000)
})

test('funded but still short after the wait is a network problem', async () => {
  const c = clock()
  await assert.rejects(withTransferReadiness(shortage, { ...c, getBalanceUSD: async () => 0.05 }),
    e => e.code === 'hosts_unreachable' && /30 storage hosts/.test(e.message) && !/no more hosts/.test(e.message))
  assert.ok(c.now() <= 120000)
})

test('unknown balance never claims insufficient; ends as not ready', async () => {
  const c = clock()
  await assert.rejects(withTransferReadiness(shortage, { ...c, getBalanceUSD: async () => { throw new Error('signed out') } }),
    e => e.code === 'account_not_ready')
})

test('download wording uses 10 hosts', async () => {
  const c = clock()
  await assert.rejects(withTransferReadiness(shortage, { ...c, op: 'download', getBalanceUSD: async () => 1 }),
    e => /10 storage hosts a download/.test(e.message))
})

test('other errors pass through untouched', async () => {
  await assert.rejects(withTransferReadiness(() => { throw new Error('Object not found') }), /Object not found/)
})

test('packedShortageError only when every file failed for lack of hosts', () => {
  assert.ok(packedShortageError([{ ok: false, error: 'no more hosts available' }]))
  assert.equal(packedShortageError([{ ok: true }, { ok: false, error: 'no more hosts available' }]), null)
  assert.equal(packedShortageError([{ ok: false, error: 'disk full' }]), null)
})

test('parseBalanceUSD handles strings, numbers and missing values', () => {
  assert.equal(parseBalanceUSD({ balance_usd: '0.05' }), 0.05)
  assert.equal(parseBalanceUSD({ balance_usd: 0 }), 0)
  assert.equal(parseBalanceUSD({}), null)
})
