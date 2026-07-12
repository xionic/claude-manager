FROM node:20-bookworm

ARG UID=1000
ARG GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    curl \
    ca-certificates \
    ripgrep \
    jq \
    sudo \
    less \
    unzip \
    zip \
    file \
    && rm -rf /var/lib/apt/lists/*

# Remap stock 'node' user (uid 1000) to 'claude'
RUN userdel -r node 2>/dev/null || true \
    && groupadd -g ${GID} claude \
    && useradd -u ${UID} -g ${GID} -m -s /bin/bash claude

# Passwordless sudo for the container user
RUN echo 'claude ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/claude && chmod 440 /etc/sudoers.d/claude

# Install Claude Code globally. The in-container auto-updater is disabled (see
# below), so the image build is the ONLY way Claude advances — pin to @latest and
# use a cache-bust arg so a rebuild always pulls the current version instead of
# reusing a stale cached layer. claude-manager passes a fresh CLAUDE_CACHE_BUST.
ARG CLAUDE_CACHE_BUST=0
RUN npm install -g @anthropic-ai/claude-code@latest

# claude is installed as root, so the container user can't self-update at
# runtime; disabling the auto-updater avoids a noisy "Auto-update failed" error
# inside every session.
ENV DISABLE_AUTOUPDATER=1

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Pre-create a claude-owned ~/.claude so a fresh persistent volume mounted there
# is initialised with the right ownership (Docker copies the image dir's
# ownership into an empty named volume), letting the sandboxed Claude write its
# session history.
RUN mkdir -p /workspace /run/claude-creds /home/claude/.claude \
    && chown claude:claude /workspace /home/claude/.claude

USER claude
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude", "--dangerously-skip-permissions"]
