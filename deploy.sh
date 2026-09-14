#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — pull updates and deploy the Tessera drop app to the live server.
# Run from /root/tessera-apps (the script lives there).

REPO_DIR="/root/tessera-apps"
DROP_DIR="/var/www/siagate/v2/tessera/drop"
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
echo "[3/5] copying dist → $DROP_DIR"
rm -rf "$DROP_DIR/src" "$DROP_DIR/vendor" "$DROP_DIR/index.html" "$DROP_DIR/assets" 2>/dev/null || true
cp -r "$REPO_DIR/apps/web/dist/"* "$DROP_DIR/"
echo "       $(ls "$DROP_DIR")"

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