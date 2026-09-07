# "No More Hosts Available" — Root Cause Analysis

**Date:** 2026-09-06
**Server:** `74.113.234.189` (hostname: `wayne`)
**Affected service:** `index.dithr.dev` — Tessera Sia storage uploads via native SDK

---

## 1. Symptom

Uploads to Sia (via the `@siafoundation/sia-storage` native NAPI SDK) fail intermittently with:

> `queue error: no more hosts available`

The error originates in the SDK's Rust layer (`sia_storage::hosts`, `AcquireError` variant). It fires when the SDK exhausts all candidate hosts returned by the indexer without finding one that accepts the upload.

**Observed rate:** ~20% of upload attempts (~1 in 5) fail.

---

## 2. Server State

| Metric | Value | Assessment |
|--------|-------|-----------|
| CPU usage | 78% user, ~0% idle | **Severely overloaded** |
| Postgres container | 364% CPU (3.6 cores) | **Dominant consumer** |
| Indexd container | 180% CPU (1.8 cores) | Heavy slab migration load |
| RAM | 9.7 GB total, 603 MB free | Tight but not critical |
| Swap | 2.6 GB / 4 GB used | Significant paging |
| Uptime | 47 days | Long-running, no recent restart |
| Load average | 3.58 / 6.17 / 5.73 | Consistently above core count |

**The server is under-provisioned for its current workload.** A 4-core machine is running indexd + Postgres + 7 Hermes gateway processes + gopls LSP + pyright + a dashboard — all simultaneously.

---

## 3. Root Cause: Slab migration recovery is consuming all available hosts

### 3.1 What's happening

The indexd is configured with **4 slab migration workers** (`slabs.migrationWorkers: 4`) and **migrations enabled** (`slabs.migrations: true`). These workers are continuously trying to recover/rebalance shards across **8,846 slabs** (265,380 sectors).

Each migration recovery cycle:

1. Queries the indexer for candidate hosts (returns ~290 per query)
2. Downloads shards from existing hosts (10 downloads needed per slab)
3. Re-uploads to new hosts
4. On failure, **demotes the host** from the candidate pool

### 3.2 The evidence

In just **30 seconds of logs** (500 lines):

```
111  shard download failures   ("stream was gracefully closed")
 14  host demotions            (hosts removed from candidate pool)
  0  "no more hosts" in indexd logs (the error originates in the SDK, not indexd)
```

Demoted hosts in that 30-second window include:
```
ed25519:9167094d... (3 demotions)
ed25519:8f6201fa... (5 demotions)
ed25519:5318de47... (2 demotions)
ed25519:f166b306... (2 demotions)
ed25519:0bf764fe... (2 demotions)
... and many more
```

### 3.3 The contention

User uploads and slab migrations **compete for the same hosts simultaneously**:

```
User upload (SDK)          Slab migration recovery (indexd)
     │                              │
     ├─ query hosts (~290) ─────────┤  query hosts (~290)
     ├─ connect to host A ──────────┤  download from host A
     ├─ host A fails ───────────────┤  host A closes mid-stream
     ├─ host A gets demoted ────────┤  host A gets demoted
     ├─ connect to host B ──────────┤  download from host B
     ├─ host B fails ───────────────┤  host B closes mid-stream
     │      ...                      │      ...
     └─ ALL hosts exhausted ────────┤  (still keeps trying)
        → "no more hosts available"
```

When a host is demoted by migration recovery, it's immediately removed from the pool available to the SDK. With 4 workers demoting ~28 hosts/minute just in the visible sample, the effective pool shrinks rapidly.

---

## 4. Contributing Factors

### 4.1 Postgres is the bottleneck

Every host lookup runs a massive CTE query (shown below) that takes **100-300ms per call**. With migration workers making concurrent queries, Postgres becomes the dominant CPU consumer at 364%.

```sql
-- Every host check runs this entire query:
WITH globals AS (
  SELECT scanned_height, contracts_period, hosts_min_collateral,
         hosts_max_storage_price, hosts_max_ingress_price, hosts_max_egress_price,
         host_min_version, sectors_per_tb, one_tb, one_sc
  FROM global_settings
), hosts AS (
  SELECT id, public_key, last_announcement, blocked, reasons,
         lost_sectors, unpinned_sectors, last_failed_scan, last_successful_scan,
         next_scan, consecutive_failed_scans, recent_uptime, ... (30+ columns),
         has_quic, has_siamux, stuck_since
  FROM hosts LEFT JOIN hosts_blocklist hb ON hosts.public_key = hb.public_key
  WHERE hosts.public_key = $1
) SELECT hosts.*,
  recent_uptime >= 0.9,               -- uptime gate
  settings_max_contract_duration >= ..., -- 12+ boolean gates evaluated per host
  has_quic, has_siamux,               -- protocol support
  settings_contract_price <= ...,     -- pricing gates
  settings_collateral >= ...,         -- collateral gates
  ... (more gates)
FROM hosts CROSS JOIN globals;
```

This runs for **every host** in every migration decision — hundreds of times per second.

### 4.2 Blocklisted hosts (76 total)

The hosts blocklist has 76 entries, mostly for:
- **Uptime** (low `recent_uptime < 0.9`)
- **AcceptingContracts** (host not accepting new contracts)
- MaxContractDuration, Collateral, EgressPrice

### 4.3 Hosts with chronic scan failures

15 hosts have **130-1,506 consecutive failed scans**. The worst offender has 1,506 consecutive failures (hasn't been successfully scanned in days). These hosts stay in the pool but fail every attempt, wasting connection attempts.

| Host ID (first 8 bytes) | Consecutive failed scans | Recent Uptime |
|-------------------------|--------------------------|---------------|
| `30c5fe20...` | 1,506 | 0.899 |
| `e6428965...` | 1,122 | 0.899 |
| `c2523c9f...` | 1,098 | 0.899 |
| `7971523c...` | 1,032 | 0.899 |
| `5cfaa0fc...` | 1,002 | 0.899 |

### 4.4 Broken Fleet DB connection

The `TESSERA_FLEET_DSN` uses password `testpw` but the fleet database requires a different password. This causes **71 repaircost INSERT failures per 2,000 log lines**:

```
repaircost: INSERT failed for N event(s): 
  failed to connect to user=indexd database=fleet:
  FATAL: password authentication failed for user "indexd"
```

### 4.5 Stale contracts

Contract maintenance shows "contract not found" errors during funding:
```
failed to replenish pools: contract not found (2)
failed to refresh contract: contract not found (2)
```

---

## 5. Current Config (`/data/indexd.yml`)

```yaml
contracts:
  minHostDistanceKm: 0     # Geographic check disabled (hosts cluster at same coords)

slabs:
  migrationWorkers: 4      # ← THIS IS THE PROBLEM
  migrations: true         # ← ENABLED during active use
```

**`minHostDistanceKm: 0`** is intentional per the config comments: hosts cluster on identical datacenter coordinates (29 at Madrid, 23 at Paris, 22 at Kyiv), so any positive threshold rejects them all. The trade-off is zero geographic redundancy.

---

## 6. Fixes (ordered by impact)

### 🔴 Immediate: Reduce or disable slab migrations

**This is the single highest-impact fix.** Freeing the hosts from competing migration recovery will immediately reduce "no more hosts available" failures.

```yaml
# /data/indexd.yml
slabs:
  migrationWorkers: 1      # was 4 (or set to 0 to pause)
  migrations: false        # temporarily disable until server is upgraded
```

**Expected effect:** Host pool no longer shared with migration recovery; user uploads get exclusive access to all 290 candidates.

### 🟡 Short-term: Fix the Fleet DB password

Update `TESSERA_FLEET_DSN` with the correct password so `repaircost` can write metrics:
```
Current: TESSERA_FLEET_DSN=postgres://indexd:testpw@postgres:5432/fleet
Fix:     TESSERA_FLEET_DSN=postgres://indexd:<correct_password>@postgres:5432/fleet
```

Check what password fleet DB expects:
```bash
docker exec tessera-postgres-1 psql -U indexd -d fleet -c "SELECT 1"
# If it asks for password, check pgpass or try the indexd DB password
```

### 🟡 Short-term: Prune dead hosts from the blocklist

Remove hosts with >500 consecutive failed scans from the active pool:
```sql
-- Check the worst offenders
SELECT encode(public_key, 'hex'), consecutive_failed_scans, recent_uptime
FROM hosts WHERE consecutive_failed_scans > 500
ORDER BY consecutive_failed_scans DESC;

-- Move to blocklist if appropriate
INSERT INTO hosts_blocklist (public_key, reasons) 
SELECT public_key, '{Dead}' FROM hosts WHERE consecutive_failed_scans > 500;
```

### 🟢 Medium-term: Server upgrade

The current machine (4 cores, 10 GB RAM) is insufficient for:
- indexd with slab migration (1.8 cores)
- Postgres with ~265K sectors and complex host queries (3.6 cores)
- 7 Hermes gateway processes
- LSP servers (gopls, pyright), dashboard, etc.

**Recommendation:** At minimum, 8 cores + 16 GB RAM, or separate Postgres to its own machine.

### 🟢 Medium-term: Add `pg_stat_statements` for query diagnostics

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

This would let us identify and optimize the slowest host queries.

### 🔵 Long-term: Reduce host query overhead

Consider adding an index on `hosts.public_key` to speed up the host lookup CTE, or caching host eligibility results for a short TTL (1-5 seconds).

---

## 7. How to Verify the Fix

After reducing migration workers:

```bash
# 1. Restart indexd with new config
docker restart tessera-indexd-1

# 2. Run 10 uploads in a loop and count failures
for i in $(seq 1 10); do
  echo -n "test $i $(date)" > /tmp/t.txt
  curl -s -X POST "http://localhost:3099/__sia__/upload?name=t.txt&mime=text/plain&appId=1483449cb22e73c9936cc4153bf071c4008c0787faf078d35bf95f702b326f23&appKey=6be4f21d5a4da5ab422077cb8188885e947f10aced92cded35c5aa9afad9d42c" --data-binary @/tmp/t.txt
  echo " --- attempt $i"
done

# 3. Expected: 0 failures (previously ~2 out of 10 would fail)
```

---

## 8. Key Database Stats (for reference)

| Table | Count |
|-------|-------|
| Hosts | 562 |
| Hosts with successful scan | 538 |
| Hosts with `recent_uptime >= 0.9` | 462 |
| Hosts with siamux support | 562 |
| Hosts with QUIC support | 561 |
| Hosts blocklisted | 76 |
| Contracts | 895 |
| Slabs | 8,846 |
| Sectors | 265,380 |

---

*Analysis performed 2026-09-06 on `root@74.113.234.189`.*