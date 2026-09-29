#!/usr/bin/env bash
# Installs claude-launcher as an always-on systemd user service and exposes it
# over HTTPS on your tailnet via Tailscale Serve. Idempotent — safe to re-run.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node)"

# config.json holds local settings and is not in git; start from the example.
if [ ! -f "$APP_DIR/config.json" ]; then
  cp "$APP_DIR/config.example.json" "$APP_DIR/config.json"
  echo "→ created : $APP_DIR/config.json (from config.example.json — edit favorites there)"
fi

PORT="$(node -e "process.stdout.write(String(require('$APP_DIR/config.json').port||8838))")"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/claude-launcher.service"

echo "→ app dir : $APP_DIR"
echo "→ node    : $NODE_BIN"
echo "→ port    : $PORT"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Claude Launcher PWA
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $APP_DIR/server.mjs
WorkingDirectory=$APP_DIR
Restart=on-failure
RestartSec=2
Environment=PORT=$PORT
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
echo "→ wrote   : $UNIT"

# Keep user services running without an active login session.
loginctl enable-linger "$USER" 2>/dev/null || echo "  (could not enable linger automatically; run: sudo loginctl enable-linger $USER)"

systemctl --user daemon-reload
systemctl --user enable --now claude-launcher.service
sleep 1
if systemctl --user is-active --quiet claude-launcher.service; then
  echo "✓ service running"
else
  echo "✗ service failed to start — logs:"
  systemctl --user status --no-pager claude-launcher.service | tail -20 || true
  exit 1
fi

# Verify it actually answers locally (bounded retry for cold/slow starts).
ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" = 1 ]; then
  echo "✓ http://127.0.0.1:$PORT responding"
else
  echo "✗ local health check failed after ~10s — logs:"
  journalctl --user -u claude-launcher --no-pager | tail -20 || true
  exit 1
fi

echo
echo "→ Exposing over HTTPS via Tailscale Serve…"
if tailscale serve --bg "$PORT" 2>/tmp/ts-serve-err; then
  HOST="$(tailscale status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,'')))")"
  echo "✓ Serving at: https://$HOST/"
  # The server's Host allowlist refuses anything not listed, including this
  # machine's own tailnet name. An empty or absent list switches the check off,
  # so only a non-empty list is extended. config.json is re-read per request.
  if ! node -e "const h = require('$APP_DIR/config.json').allowedHosts;
      process.exit(!h || !h.length || h.includes(process.argv[1]) ? 0 : 1)" "$HOST"; then
    node -e "
      const fs = require('fs'), f = '$APP_DIR/config.json', c = JSON.parse(fs.readFileSync(f, 'utf8'));
      c.allowedHosts.push(process.argv[1]);
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');" "$HOST"
    echo "✓ added $HOST to allowedHosts in config.json"
  fi
else
  echo "✗ tailscale serve failed:"; cat /tmp/ts-serve-err
  echo "  Common fixes:"
  echo "   • Enable HTTPS certs in the Tailscale admin console (Settings → Keys/HTTPS), then re-run."
  echo "   • Or allow your user to run tailscale: sudo tailscale set --operator=$USER"
  echo "   • Then: tailscale serve --bg $PORT"
fi

echo
echo "Done. On your iPhone (connected to the same tailnet):"
echo "  1. Open the HTTPS URL above in Safari."
echo "  2. Share → Add to Home Screen."
echo
echo "Manage:  systemctl --user {status,restart,stop} claude-launcher"
echo "Logs:    journalctl --user -u claude-launcher -f"
echo "Stop serving: tailscale serve reset"
