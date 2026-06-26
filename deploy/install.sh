#!/usr/bin/env bash
#
# Claude Manager — one-shot installer. Run with sudo:
#
#     sudo /home/youruser/projects/claude_manager/deploy/install.sh
#
# It is idempotent: safe to re-run after pulling changes. It installs the
# systemd service (running as the app user), enables the needed Apache modules,
# sets up Basic auth, installs the reverse-proxy config, validates the Apache
# config, and reloads. Nothing is touched if the Apache config test fails.
#
# Optional env overrides:
#   APP_USER=pi            user the service runs as (owns the tmux server)
#   APP_DIR=/home/youruser/projects/claude_manager
#   AUTH_USER=youruser         Basic-auth username
#   AUTH_PASS=...          set to install non-interactively (else prompted)
#   PORT=8765
#   HTPASSWD_FILE=/etc/apache2/.htpasswd
#                          point at an existing file to reuse it (user must
#                          already exist in it — the script won't touch the file
#                          or prompt for a password)
set -euo pipefail

APP_USER="${APP_USER:-pi}"
APP_DIR="${APP_DIR:-/home/youruser/projects/claude_manager}"
AUTH_USER="${AUTH_USER:-youruser}"
PORT="${PORT:-8765}"
HTPASSWD_FILE="${HTPASSWD_FILE:-/etc/apache2/.htpasswd}"
SERVICE_SRC="$APP_DIR/deploy/claude-manager.service"
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
id "$APP_USER" >/dev/null 2>&1 || { c_err "user '$APP_USER' does not exist"; exit 1; }
c_ok "app user: $APP_USER"

[[ -f "$APP_DIR/server.js" ]] || { c_err "server.js not found in $APP_DIR"; exit 1; }
c_ok "app dir: $APP_DIR"

[[ -f "$SERVICE_SRC" ]] || { c_err "service unit not found: $SERVICE_SRC"; exit 1; }

command -v node >/dev/null || { c_err "node is not installed"; exit 1; }
c_ok "node: $(node --version)"

command -v apache2ctl >/dev/null || command -v apachectl >/dev/null \
  || { c_err "apache2 does not appear to be installed"; exit 1; }
APACHECTL="$(command -v apache2ctl || command -v apachectl)"

command -v htpasswd >/dev/null || { c_err "htpasswd missing — install apache2-utils"; exit 1; }
c_ok "apache tooling present"

# ---- systemd service -------------------------------------------------------
step "Installing systemd service"
install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
c_ok "copied unit -> $SERVICE_DST"
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

# ---- Apache modules --------------------------------------------------------
step "Enabling Apache modules"
a2enmod proxy proxy_http auth_basic authn_file authz_host >/dev/null
c_ok "proxy, proxy_http, auth_basic, authn_file, authz_host enabled"

# ---- Basic auth user -------------------------------------------------------
step "Basic-auth credentials"
if [[ -f "$HTPASSWD_FILE" ]] && grep -q "^${AUTH_USER}:" "$HTPASSWD_FILE" 2>/dev/null; then
  # User already in file — leave it alone (works for shared files like .htpasswd
  # that belong to other vhosts and may have different ownership).
  c_ok "user '$AUTH_USER' found in $HTPASSWD_FILE — reusing it"
  c_info "to change the password:  sudo htpasswd $HTPASSWD_FILE $AUTH_USER"
else
  # File is new (needs -c) or user is absent. Create/add and lock down perms.
  if [[ -n "${AUTH_PASS:-}" ]]; then
    if [[ -f "$HTPASSWD_FILE" ]]; then
      htpasswd -bB "$HTPASSWD_FILE" "$AUTH_USER" "$AUTH_PASS" >/dev/null
    else
      htpasswd -cbB "$HTPASSWD_FILE" "$AUTH_USER" "$AUTH_PASS" >/dev/null
    fi
    c_ok "set password for '$AUTH_USER' (non-interactive)"
  else
    c_info "Enter a password for Basic-auth user '$AUTH_USER':"
    if [[ -f "$HTPASSWD_FILE" ]]; then
      htpasswd -B "$HTPASSWD_FILE" "$AUTH_USER"
    else
      htpasswd -cB "$HTPASSWD_FILE" "$AUTH_USER"
    fi
    c_ok "credentials saved"
  fi
  chown root:www-data "$HTPASSWD_FILE"
  chmod 0640 "$HTPASSWD_FILE"
fi

# ---- Apache reverse-proxy config ------------------------------------------
step "Installing Apache reverse-proxy config"
# Written as a global conf-available file so it applies to all vhosts
# (including the SSL vhost) without editing them.
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
c_ok "wrote $CONF_DST"
a2enconf claude-manager >/dev/null
c_ok "enabled conf"

# ---- validate + reload -----------------------------------------------------
step "Validating Apache configuration"
if "$APACHECTL" configtest; then
  c_ok "config test passed"
  systemctl reload apache2
  c_ok "apache reloaded"
else
  c_err "apache configtest FAILED — not reloading. Disabling our conf to be safe."
  a2disconf claude-manager >/dev/null 2>&1 || true
  exit 1
fi

# ---- done ------------------------------------------------------------------
step "Done"
HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
c_ok "Service:  http://127.0.0.1:${PORT}/  (localhost only)"
c_ok "Public:   https://${HOST:-<your-pi>}/claude-manager/  (Basic auth, LAN only)"
echo
c_info "Logs:     journalctl -u claude-manager -f"
c_info "Restart:  sudo systemctl restart claude-manager"
c_warn "Review the 'Require ip' line in $CONF_DST if your LAN isn't 192.168/10.x."
