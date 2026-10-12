#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — pull updates and deploy the Tessera Web app to the live server.
# Run from /root/tessera-apps (the script lives there).
#
# RENAME (2026-09-29): apps/web is now Tessera Web (formerly apps/tessera-web) --
# the map/folders/invite-flow app. The old Drop app (apps/web's previous
# contents) was removed from the repo; /v2/tessera/drop/ now 301-redirects to
# /v2/tessera/web/ in nginx. This script's deploy target moved from
# /var/www/siagate/v2/tessera/drop to /var/www/siagate/v2/tessera/web to match.
#
# NO SERVICE RESTART (2026-10-12): this script used to `systemctl restart
# tessera-proxy` and smoke-test port 3099. That relay is retired and is
# intentionally stopped and disabled (the account-37 security fix); nginx
# serves /web/ (and /v2/tessera/web/) straight from WEB_DIR. The deploy now
# only pulls, builds, backs up, copies, and smoke-tests the REAL live path. It
# never touches tessera-proxy, and it asserts at the end that the unit is still
# inactive and disabled, so any regression here fails loudly.

REPO_DIR="/root/tessera-apps"
WEB_DIR="/var/www/siagate/v2/tessera/web"
BACKUP_DIR="/root/tessera-backups"
WEB_URL="https://tessera.storage/web/"

cd "$REPO_DIR"

echo "=== deploy: $(date -u +'%Y-%m-%d %H:%M:%S UTC') ==="

# ── 1. Pull ──────────────────────────────────────────────
echo "[1/4] git pull"
BEFORE=$(git rev-parse HEAD)
git pull --ff-only
AFTER=$(git rev-parse HEAD)

# ── 2. Build SPA (only if source changed) ────────────────
if [ "$BEFORE" != "$AFTER" ]; then
  echo "[2/4] source changed ($(git log --oneline -1 HEAD)) — rebuilding SPA"
  npm run build:web
else
  echo "[2/4] source unchanged — skip build"
fi
if [ ! -f "$REPO_DIR/apps/web/dist/index.html" ]; then
  echo "ERROR: $REPO_DIR/apps/web/dist/index.html is missing — nothing to deploy" >&2
  exit 1
fi

# ── 3. Back up the live directory, then copy the new build ──
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/web-${TS}.tgz"
echo "[3/4] backing up $WEB_DIR → $BACKUP"
tar czf "$BACKUP" -C "$(dirname "$WEB_DIR")" "$(basename "$WEB_DIR")"
echo "[3/4] copying dist → $WEB_DIR"
rm -rf "$WEB_DIR/src" "$WEB_DIR/vendor" "$WEB_DIR/index.html" "$WEB_DIR/assets" 2>/dev/null || true
cp -r "$REPO_DIR/apps/web/dist/"* "$WEB_DIR/"

# ── 4. Smoke test the REAL live path (never the retired :3099 proxy) ──
# nginx serves /web/ with an SPA fallback (try_files ... /web/index.html), so a
# missing asset still answers 200 text/html. The test therefore checks that the
# LIVE page references the asset this deploy just built AND that the asset is
# really served as JavaScript — not just that some request answered 200.
ASSET=$(grep -oE 'assets/[A-Za-z0-9._-]+\.js' "$REPO_DIR/apps/web/dist/index.html" | head -1 || true)
echo "[4/4] smoke test $WEB_URL (asset: ${ASSET:-none})"
HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL" 2>/dev/null || echo "000")
LIVE_REF=$(curl -s "$WEB_URL" 2>/dev/null | grep -oE 'assets/[A-Za-z0-9._-]+\.js' | head -1 || true)
ASSET_TYPE=$(curl -s -o /dev/null -w '%{content_type}' "${WEB_URL}${ASSET}" 2>/dev/null || true)
PROXY_ACTIVE=$(systemctl is-active tessera-proxy 2>/dev/null || true)
PROXY_ENABLED=$(systemctl is-enabled tessera-proxy 2>/dev/null || true)

SMOKE_OK=1
[ "$HTTP" = "200" ] || SMOKE_OK=0
[ -n "$ASSET" ] && [ "$LIVE_REF" = "$ASSET" ] || SMOKE_OK=0
case "$ASSET_TYPE" in *javascript*) ;; *) SMOKE_OK=0 ;; esac
if [ "$SMOKE_OK" = "1" ]; then
  echo "       live OK (page $HTTP, serving $ASSET as $ASSET_TYPE)"
else
  echo "       ERROR: live smoke test failed (page $HTTP, local asset ${ASSET:-none}, live ref ${LIVE_REF:-none}, asset type ${ASSET_TYPE:-none}); backup at $BACKUP" >&2
  exit 1
fi
if [ "$PROXY_ACTIVE" = "inactive" ] && [ "$PROXY_ENABLED" = "disabled" ]; then
  echo "       tessera-proxy still inactive/disabled (retired relay untouched)"
else
  echo "       ERROR: tessera-proxy is $PROXY_ACTIVE/$PROXY_ENABLED — it must stay inactive/disabled" >&2
  exit 1
fi

echo "=== deploy: done (backup: $BACKUP) ==="
