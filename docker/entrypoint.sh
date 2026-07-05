#!/bin/bash
set -e

# --- Claude home ---
# When claude-manager mounts a persistent named volume at ~/.claude, an empty
# volume is initialised root-owned, so `pi` can't write to it. Take ownership
# (pi has passwordless sudo in this image) before touching it.
mkdir -p "$HOME/.claude" 2>/dev/null || true
if [ "$(stat -c %u "$HOME/.claude" 2>/dev/null || echo 0)" != "$(id -u)" ]; then
    sudo chown -R "$(id -u):$(id -g)" "$HOME/.claude" 2>/dev/null || true
fi

# --- Auth setup ---
CREDS_SRC="/run/claude-creds/.credentials.json"
if [ -f "$CREDS_SRC" ]; then
    cp "$CREDS_SRC" "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
fi

# --- Seed settings so no interactive prompts block the session ---
mkdir -p "$HOME/.claude"

SETTINGS="$HOME/.claude/settings.json"
if [ ! -f "$SETTINGS" ]; then
    echo '{}' > "$SETTINGS"
fi
jq '. + {"skipDangerousModePermissionPrompt": true, "theme": "dark"}' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

CLAUDE_JSON="$HOME/.claude.json"
if [ ! -f "$CLAUDE_JSON" ]; then
    echo '{}' > "$CLAUDE_JSON"
fi
# Pre-accept onboarding AND the per-project "Do you trust this folder?" dialog
# for /workspace (the project is always mounted there). Without this the
# container's Claude blocks on the trust prompt and never starts / registers
# remote control. Mirrors ensureTrusted() on the host.
jq '. + {"hasCompletedOnboarding": true, "dontCrawlDirectory": false}
    | .projects = (.projects // {})
    | .projects["/workspace"] = ((.projects["/workspace"] // {}) + {
        "hasTrustDialogAccepted": true,
        "hasCompletedProjectOnboarding": true,
        "projectOnboardingSeenCount": 1
      })' "$CLAUDE_JSON" > "$CLAUDE_JSON.tmp" && mv "$CLAUDE_JSON.tmp" "$CLAUDE_JSON"

# --- Run: prompted (non-interactive) or interactive ---
PROMPT_FILE="/run/claude-prompt"
LOG_FILE="/workspace/claude-session.log"

if [ -f "$PROMPT_FILE" ]; then
    PROMPT_TEXT=$(cat "$PROMPT_FILE")
    echo "[claude-sandbox] Session started at $(date)" | tee "$LOG_FILE"
    echo "[claude-sandbox] Running with prompt (non-interactive, --dangerously-skip-permissions)" | tee -a "$LOG_FILE"
    echo "========================================" | tee -a "$LOG_FILE"
    exec claude --dangerously-skip-permissions -p "$PROMPT_TEXT" "$@" 2>&1 | tee -a "$LOG_FILE"
else
    exec "$@"
fi
