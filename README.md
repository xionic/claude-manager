# Claude Manager

A small web interface to manage [Claude Code](https://claude.com/claude-code)
sessions running as **tmux windows** — list them, kill them, and start new ones
(name + directory picker, Remote Control enabled) without touching the terminal.

It pairs with [autoclaude](https://github.com/henryaj/autoclaude), which auto-
continues sessions when the usage limit resets: this tool just creates and
manages the windows; autoclaude keeps them going.

## How it's wired

```
Browser ──TLS + Basic auth + LAN──> Apache (www-data) ──proxy──> Node service (runs as pi) ──> tmux
```

The Node service **runs as the `pi` user**, so it talks to pi's tmux server
natively — no sudo, no privilege bridge, no loosened permissions. It binds to
`127.0.0.1` only; Apache is the front door (auth + LAN restriction). The service
**never sends prompts** to Claude; it only spawns / lists / kills windows. Every
spawn parameter is strictly validated (session name regex, directory canonicalised
inside an allow-list) so the tmux command line can't be injected.

New sessions are launched exactly like you do by hand:

```
tmux new-window -t 0 -n <name> -c <dir> claude --remote-control <name> \
  (--permission-mode <auto|default|acceptEdits|plan> | --dangerously-skip-permissions) [--resume]
```

The permission mode is chosen per session in the **New session** dialog
(default **auto**); picking "Dangerously skip all permissions" uses
`--dangerously-skip-permissions`, every other mode maps to `--permission-mode`.

## Configuration (env vars)

| Var                 | Default                  | Meaning                                  |
|---------------------|--------------------------|------------------------------------------|
| `CM_PORT`           | `8765`                   | Port the Node service listens on         |
| `CM_BIND`           | `127.0.0.1`              | Bind address (keep localhost)            |
| `CM_TMUX_SESSION`   | `0`                      | tmux session new windows are created in  |
| `CM_ALLOWED_ROOTS`  | `/home/youruser,/var/www/html` | Comma-separated dir-picker roots (jail)  |
| `CM_TMUX_BIN`       | `/usr/bin/tmux`          | tmux binary                              |
| `CM_CLAUDE_BIN`     | `claude`                 | claude binary (resolved in window env)   |
| `CM_TMUX_SOCKET`    | `/tmp/tmux-<uid>/default`| tmux socket path                         |

## Run it manually (to test)

```bash
cd /home/youruser/projects/claude_manager
node server.js
# then, in another terminal:
curl -s localhost:8765/api/sessions | jq
```

Open http://localhost:8765/ directly while testing.

## Quick install (does everything)

```bash
sudo /home/youruser/projects/claude_manager/deploy/install.sh
```

This installs + starts the systemd service, enables the Apache modules, prompts
for a Basic-auth password, installs the reverse-proxy config, validates the
Apache config (and refuses to reload if it's broken), and prints the URL. It is
idempotent — re-run it any time. Non-interactive variant:

```bash
sudo AUTH_USER=youruser AUTH_PASS='your-pw' /home/youruser/projects/claude_manager/deploy/install.sh
```

Afterwards, review the `Require ip` line in `/etc/apache2/conf-available/claude-manager.conf`
if your LAN isn't `192.168.x` / `10.x` (add your Tailscale range there too).

The manual steps below are equivalent, if you'd rather do them by hand.

## Install as a service

```bash
sudo cp deploy/claude-manager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-manager
sudo systemctl status claude-manager
journalctl -u claude-manager -f       # logs
```

> Note: the systemd unit runs as a normal system service with `User=pi`. It
> reaches the tmux server pi already has running at `/tmp/tmux-1000/default`.
> That tmux server must be running (your existing attached session) for new
> windows to appear in it.

## Put Apache in front

```bash
# 1. Enable the needed modules
sudo a2enmod proxy proxy_http auth_basic authn_file authz_host

# 2. Create the Basic-auth user
sudo htpasswd -c /etc/apache2/claude-manager.htpasswd youruser

# 3. Add the proxy block to a vhost (see deploy/apache-claude-manager.conf),
#    e.g. paste it inside the SSL vhost, then:
sudo systemctl reload apache2
```

Visit `https://<your-pi>/claude-manager/`.

## Security notes

- Starting a session launches `claude` **as pi** in the chosen permission mode.
  The "Dangerously skip all permissions" option runs Claude with no permission
  checks, so treat access as equivalent to a shell login for the `pi` user —
  keep it behind auth and on the LAN/Tailscale only, never public.
- The dir picker is jailed to `CM_ALLOWED_ROOTS` with symlinks resolved; paths
  outside are rejected (403).
- Session names are limited to `[A-Za-z0-9._-]{1,64}`.
