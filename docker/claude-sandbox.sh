#!/bin/bash
set -euo pipefail

IMAGE="claude-sandbox:latest"
DOCKERFILE_DIR="$(cd "$(dirname "$0")" && pwd)"
CREDS="$HOME/.claude/.credentials.json"

usage() {
    cat <<EOF
Usage:
  $(basename "$0") <session-name> <project-dir> [options]
  $(basename "$0") --rebuild
  $(basename "$0") --rm <session-name>

Options:
  --prompt <text>         Run non-interactively with this prompt text
  --prompt-file <path>    Run non-interactively with prompt from file
  --rebuild               Force rebuild of the Docker image
  --rm <name>             Remove the named sandbox container

Example:
  $(basename "$0") my-project ~/projects/my-project
  $(basename "$0") my-project ~/projects/my-project --prompt-file /tmp/task.txt
EOF
}

sanitize_name() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}

build_image() {
    echo "[claude-sandbox] Building image $IMAGE ..."
    docker build -t "$IMAGE" "$DOCKERFILE_DIR"
    echo "[claude-sandbox] Image built."
}

ensure_image() {
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        build_image
    fi
}

# ---- Parse args ----
REBUILD=false
RM_NAME=""
SESSION_NAME=""
PROJECT_DIR=""
PROMPT_TEXT=""
PROMPT_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rebuild)
            REBUILD=true
            shift
            ;;
        --rm)
            RM_NAME="$2"
            shift 2
            ;;
        --prompt)
            PROMPT_TEXT="$2"
            shift 2
            ;;
        --prompt-file)
            PROMPT_FILE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            if [ -z "$SESSION_NAME" ]; then
                SESSION_NAME="$1"
            elif [ -z "$PROJECT_DIR" ]; then
                PROJECT_DIR="$1"
            else
                echo "Error: unexpected argument: $1" >&2
                usage
                exit 1
            fi
            shift
            ;;
    esac
done

# ---- --rebuild ----
if $REBUILD; then
    build_image
    exit 0
fi

# ---- --rm ----
if [ -n "$RM_NAME" ]; then
    CLEAN=$(sanitize_name "$RM_NAME")
    CONTAINER="claude-sandbox-$CLEAN"
    echo "[claude-sandbox] Removing container $CONTAINER ..."
    docker rm -f "$CONTAINER" 2>/dev/null || true
    echo "[claude-sandbox] Done."
    exit 0
fi

# ---- Validate required args ----
if [ -z "$SESSION_NAME" ] || [ -z "$PROJECT_DIR" ]; then
    echo "Error: session-name and project-dir are required." >&2
    usage
    exit 1
fi

PROJECT_DIR=$(realpath "$PROJECT_DIR")
if [ ! -d "$PROJECT_DIR" ]; then
    echo "Error: project directory does not exist: $PROJECT_DIR" >&2
    exit 1
fi

CLEAN=$(sanitize_name "$SESSION_NAME")
CONTAINER="claude-sandbox-$CLEAN"

# ---- Resolve prompt ----
PROMPT_MOUNT_ARGS=()
PROMPT_TEMP=""

if [ -n "$PROMPT_FILE" ]; then
    PROMPT_FILE=$(realpath "$PROMPT_FILE")
    if [ ! -f "$PROMPT_FILE" ]; then
        echo "Error: prompt file not found: $PROMPT_FILE" >&2
        exit 1
    fi
    PROMPT_MOUNT_ARGS=(-v "$PROMPT_FILE":/run/claude-prompt:ro)
elif [ -n "$PROMPT_TEXT" ]; then
    PROMPT_TEMP=$(mktemp)
    echo "$PROMPT_TEXT" > "$PROMPT_TEMP"
    PROMPT_MOUNT_ARGS=(-v "$PROMPT_TEMP":/run/claude-prompt:ro)
fi

# ---- Ensure image ----
ensure_image

# ---- Check creds ----
if [ ! -f "$CREDS" ]; then
    echo "Warning: $CREDS not found; container will need manual auth." >&2
    CREDS_MOUNT=()
else
    CREDS_MOUNT=(-v "$CREDS":/run/claude-creds/.credentials.json:ro)
fi

# ---- Determine claude command ----
if [ ${#PROMPT_MOUNT_ARGS[@]} -gt 0 ]; then
    # Prompted (non-interactive): entrypoint detects /run/claude-prompt and runs -p
    CLAUDE_CMD=()
else
    # Interactive with remote control
    CLAUDE_CMD=(claude --dangerously-skip-permissions --remote-control "$SESSION_NAME" -n "$SESSION_NAME")
fi

# ---- Run ----
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    if [ ${#PROMPT_MOUNT_ARGS[@]} -gt 0 ]; then
        echo "[claude-sandbox] WARNING: Container $CONTAINER already exists but a prompt was given."
        echo "[claude-sandbox] Prompts only apply to new containers. Starting existing container interactively."
        echo "[claude-sandbox] Use --rm $SESSION_NAME first to recreate with a prompt."
        docker start -ai "$CONTAINER"
    else
        echo "[claude-sandbox] Resuming existing container: $CONTAINER"
        docker start -ai "$CONTAINER"
    fi
else
    echo "[claude-sandbox] Creating container: $CONTAINER"
    echo "[claude-sandbox] Project dir: $PROJECT_DIR"
    if [ ${#PROMPT_MOUNT_ARGS[@]} -gt 0 ]; then
        echo "[claude-sandbox] Running with prompt (non-interactive)"
    else
        echo "[claude-sandbox] Starting interactive session with remote control: $SESSION_NAME"
    fi

    if [ ${#PROMPT_MOUNT_ARGS[@]} -gt 0 ]; then
        # Prompted/unattended: no TTY so docker logs and tee capture output cleanly
        docker run -d \
            --name "$CONTAINER" \
            --hostname "$CONTAINER" \
            -v "$PROJECT_DIR":/workspace \
            "${CREDS_MOUNT[@]}" \
            "${PROMPT_MOUNT_ARGS[@]}" \
            -w /workspace \
            "$IMAGE"
        echo "[claude-sandbox] Session running in background."
        echo "[claude-sandbox] Monitor output: tail -f $PROJECT_DIR/claude-session.log"
        echo "[claude-sandbox] Or stream docker logs: docker logs -f $CONTAINER"
    else
        # Interactive: allocate TTY for proper terminal behaviour
        docker run -it \
            --name "$CONTAINER" \
            --hostname "$CONTAINER" \
            -v "$PROJECT_DIR":/workspace \
            "${CREDS_MOUNT[@]}" \
            -w /workspace \
            "$IMAGE" \
            "${CLAUDE_CMD[@]}"
    fi
fi

# Cleanup temp file if used
if [ -n "$PROMPT_TEMP" ]; then
    rm -f "$PROMPT_TEMP"
fi
