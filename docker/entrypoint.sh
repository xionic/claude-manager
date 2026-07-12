#!/bin/bash
set -e

# ~/.claude is bind-mounted from the host (shared credentials + session history),
# owned by the same uid as the container user — so no credential copy or ownership
# fixup is needed, and we must NOT chown or reseed settings inside it (that's the
# host's live directory).

# Pre-accept onboarding and the "Do you trust this folder?" dialog for /workspace
# in the container-local ~/.claude.json. This file lives in $HOME, NOT under the
# shared ~/.claude, so seeding it doesn't touch host state — it just stops the
# container's Claude blocking on the trust prompt. Mirrors ensureTrusted().
CLAUDE_JSON="$HOME/.claude.json"
if [ ! -f "$CLAUDE_JSON" ]; then
    echo '{}' > "$CLAUDE_JSON"
fi
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
