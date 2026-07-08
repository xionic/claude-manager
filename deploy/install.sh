#!/usr/bin/env bash
#
# Claude Manager — installer. Run with sudo from the repo:
#
#     sudo ./deploy/install.sh
#
# It installs and starts a systemd service that runs as the user who invoked
# sudo (so it uses that user's tmux server), listening on localhost only. It is
# idempotent: safe to re-run after pulling changes.
#
# By default it does NOT touch your web server — the app stays on 127.0.0.1. To
# also put Apache in front (TLS/auth reverse proxy on your LAN), pass
# WITH_APACHE=1.
#
# Optional env overrides:
#   APP_USER=<user>       user the service runs as (default: the sudo caller)
#   APP_DIR=<path>        repo location (default: this script's parent repo)
#   PORT=8765             port the service listens on
#   ALLOWED_ROOTS=<dirs>  comma-separated directory-picker roots (default: user home)
#   WITH_APACHE=1         also configure the Apache reverse proxy (see below)
#   AUTH_USER=<user>      Basic-auth username for Apache (default: APP_USER)
#   AUTH_PASS=...         set to configure Apache non-interactively (else prompted)
#   HTPASSWD_FILE=/etc/apache2/claude-manager.htpasswd
set -euo pipefail

# ---- resolve defaults ------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${APP_USER:-${SUDO_USER:-$(logname 2>/dev/null || echo root)}}"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PORT="${PORT:-8765}"
WITH_APACHE="${WITH_APACHE:-0}"
AUTH_USER="${AUTH_USER:-$APP_USER}"
HTPASSWD_FILE="${HTPASSWD_FILE:-/etc/apache2/claude-manager.htpasswd}"
SERVICE_DST="/etc/systemd/system/claude-manager.service"
CONF_DST="/etc/apache2/conf-available/claude-manager.conf"

# ---- pretty output ---------------------------------------------------------
c_ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m·\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }
step()   { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# ---- preflight -------------------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  c_err "Run with sudo:  sudo $0"
  exit 1
fi

step "Preflight checks"
id "$APP_USER" >/dev/null 2>&1 || { c_err "user '$APP_USER' does not exist (set APP_USER=)"; exit 1; }
c_ok "app user: $APP_USER"

APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
[[ -n "$APP_HOME" ]] || { c_err "could not determine home directory for $APP_USER"; exit 1; }
ALLOWED_ROOTS="${ALLOWED_ROOTS:-$APP_HOME}"

[[ -f "$APP_DIR/server.js" ]] || { c_err "server.js not found in $APP_DIR"; exit 1; }
c_ok "app dir: $APP_DIR"

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { c_err "node is not installed"; exit 1; }
c_ok "node: $("$NODE_BIN" --version) ($NODE_BIN)"

command -v tmux >/dev/null || { c_err "tmux is not installed"; exit 1; }
c_ok "tmux present"

# ---- systemd service (generated for this host) -----------------------------
step "Installing systemd service"
cat > "$SERVICE_DST" <<EOF
[Unit]
Description=Claude Manager (tmux session manager web UI)
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=on-failure
RestartSec=3

# Make sure claude (typically in ~/.local/bin) and node resolve for spawned windows.
Environment=PATH=$APP_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$APP_HOME
Environment=CM_PORT=$PORT
Environment=CM_BIND=127.0.0.1
Environment=CM_TMUX_SESSION=0
Environment=CM_ALLOWED_ROOTS=$ALLOWED_ROOTS

[Install]
WantedBy=multi-user.target
EOF
c_ok "wrote $SERVICE_DST (User=$APP_USER, roots=$ALLOWED_ROOTS)"

systemctl daemon-reload
systemctl enable claude-manager >/dev/null 2>&1 || true
systemctl restart claude-manager
sleep 1
if systemctl is-active --quiet claude-manager; then
  c_ok "claude-manager service is active"
else
  c_err "service failed to start — recent logs:"
  journalctl -u claude-manager -n 20 --no-pager || true
  exit 1
fi

# ---- optional: Apache reverse proxy ----------------------------------------
if [[ "$WITH_APACHE" == "1" ]]; then
  step "Configuring Apache reverse proxy"

  command -v apache2ctl >/dev/null || command -v apachectl >/dev/null \
    || { c_err "apache2 not found — install it or omit WITH_APACHE=1"; exit 1; }
  APACHECTL="$(command -v apache2ctl || command -v apachectl)"
  command -v htpasswd >/dev/null || { c_err "htpasswd missing — install apache2-utils"; exit 1; }

  a2enmod proxy proxy_http auth_basic authn_file authz_host >/dev/null
  c_ok "enabled proxy / auth modules"

  # Basic-auth user
  if [[ -f "$HTPASSWD_FILE" ]] && grep -q "^${AUTH_USER}:" "$HTPASSWD_FILE" 2>/dev/null; then
    c_ok "user '$AUTH_USER' already in $HTPASSWD_FILE — reusing it"
  else
    if [[ -n "${AUTH_PASS:-}" ]]; then
      [[ -f "$HTPASSWD_FILE" ]] && htpasswd -bB "$HTPASSWD_FILE" "$AUTH_USER" "$AUTH_PASS" >/dev/null \
                                || htpasswd -cbB "$HTPASSWD_FILE" "$AUTH_USER" "$AUTH_PASS" >/dev/null
      c_ok "set password for '$AUTH_USER' (non-interactive)"
    else
      c_info "Enter a Basic-auth password for '$AUTH_USER':"
      [[ -f "$HTPASSWD_FILE" ]] && htpasswd -B "$HTPASSWD_FILE" "$AUTH_USER" \
                                || htpasswd -cB "$HTPASSWD_FILE" "$AUTH_USER"
      c_ok "credentials saved"
    fi
    chown root:www-data "$HTPASSWD_FILE" 2>/dev/null || true
    chmod 0640 "$HTPASSWD_FILE"
  fi

  cat > "$CONF_DST" <<EOF
# Claude Manager — installed by deploy/install.sh. Edit the Require ip line to
# match your LAN/Tailscale, then: sudo systemctl reload apache2
<Location /claude-manager/>
    ProxyPass         http://127.0.0.1:${PORT}/
    ProxyPassReverse  http://127.0.0.1:${PORT}/

    AuthType Basic
    AuthName "Claude Manager"
    AuthUserFile ${HTPASSWD_FILE}

    <RequireAll>
        Require valid-user
        Require ip 127.0.0.1 ::1 192.168.0.0/16 10.0.0.0/8
        # Tailscale: add  100.64.0.0/10
    </RequireAll>
</Location>

RedirectMatch ^/claude-manager\$ /claude-manager/
EOF
  a2enconf claude-manager >/dev/null
  c_ok "wrote $CONF_DST"

  if "$APACHECTL" configtest; then
    systemctl reload apache2
    c_ok "apache config valid — reloaded"
  else
    c_err "apache configtest FAILED — disabling our conf and leaving apache untouched"
    a2disconf claude-manager >/dev/null 2>&1 || true
    exit 1
  fi
fi

# ---- done ------------------------------------------------------------------
step "Done"
c_ok "Service:  http://127.0.0.1:${PORT}/  (localhost only)"
if [[ "$WITH_APACHE" == "1" ]]; then
  HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  c_ok "Proxied:  https://${HOST:-<your-host>}/claude-manager/  (Basic auth, LAN only)"
  c_warn "Check the 'Require ip' line in $CONF_DST if your LAN isn't 192.168/10.x."
else
  c_info "To reach it from other devices, put a reverse proxy in front — or re-run"
  c_info "with WITH_APACHE=1 to set up Apache. See the README."
fi
c_info "Logs:     journalctl -u claude-manager -f"
c_info "Restart:  sudo systemctl restart claude-manager"
