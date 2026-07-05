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

# Remap stock 'node' user (uid 1000) to 'pi'
RUN userdel -r node 2>/dev/null || true \
    && groupadd -g ${GID} pi \
    && useradd -u ${UID} -g ${GID} -m -s /bin/bash pi

# Passwordless sudo for pi
RUN echo 'pi ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pi && chmod 440 /etc/sudoers.d/pi

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# claude is installed as root, so pi can't self-update at runtime; disabling the
# auto-updater avoids a noisy "Auto-update failed" error inside every session.
ENV DISABLE_AUTOUPDATER=1

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Pre-create a pi-owned ~/.claude so a fresh persistent volume mounted there is
# initialised with pi ownership (Docker copies the image dir's ownership into an
# empty named volume), letting the sandboxed Claude write its session history.
RUN mkdir -p /workspace /run/claude-creds /home/youruser/.claude \
    && chown pi:pi /workspace /home/youruser/.claude

USER pi
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude", "--dangerously-skip-permissions"]
