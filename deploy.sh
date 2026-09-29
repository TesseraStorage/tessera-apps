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

REPO_DIR="/root/tessera-apps"
WEB_DIR="/var/www/siagate/v2/tessera/web"
SERVICE="tessera-proxy"

cd "$REPO_DIR"

echo "=== deploy: $(date -u +'%Y-%m-%d %H:%M:%S UTC') ==="

# ── 1. Pull ──────────────────────────────────────────────
echo "[1/5] git pull"
BEFORE=$(git rev-parse HEAD)
git pull --ff-only
AFTER=$(git rev-parse HEAD)

# ── 2. Build SPA (only if source changed) ────────────────
if [ "$BEFORE" != "$AFTER" ]; then
  echo "[2/5] source changed ($(git log --oneline -1 HEAD)) — rebuilding SPA"
  npm run build:web
else
  echo "[2/5] source unchanged — skip build"
fi

# ── 3. Copy dist to live directory ───────────────────────
echo "[3/5] copying dist → $WEB_DIR"
rm -rf "$WEB_DIR/src" "$WEB_DIR/vendor" "$WEB_DIR/index.html" "$WEB_DIR/assets" 2>/dev/null || true
cp -r "$REPO_DIR/apps/web/dist/"* "$WEB_DIR/"
echo "       $(ls "$WEB_DIR")"

# ── 4. Restart proxy ─────────────────────────────────────
echo "[4/5] restarting $SERVICE"
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  echo "       $SERVICE is active"
else
  echo "       ERROR: $SERVICE failed to start" >&2
  systemctl status "$SERVICE" --no-pager -n 10
  exit 1
fi

# ── 5. Smoke test ────────────────────────────────────────
echo "[5/5] smoke test"
HTTP=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3099/" 2>/dev/null || echo "000")
if [ "$HTTP" = "200" ]; then
  echo "       proxy OK (HTTP $HTTP)"
else
  echo "       WARNING: proxy returned HTTP $HTTP" >&2
fi

echo "=== deploy: done ==="