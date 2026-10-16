# The `workspace` image (01, Container image). Versions live in container/versions.json;
# `bun run check:versions` fails when this file and versions.json disagree.
# BASE_IMAGE is pinned by digest at build time (container/pin-base.ts writes the digest).
ARG BASE_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
FROM ${BASE_IMAGE} AS workspace

ARG TINI_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash zsh ca-certificates git ripgrep fd-find tmux inotify-tools curl jq unzip zstd \
    tini=${TINI_VERSION} procps iproute2 python3 python3-venv build-essential libnss3-tools \
 && rm -rf /var/lib/apt/lists/*

# gh and bun: versions from versions.json, passed as build args
ARG GH_VERSION
ARG BUN_VERSION
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    curl -fsSL https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz \
    | tar -xz -C /tmp && mv /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"
RUN corepack enable

# Oh My Zsh, read-only for everyone; ZSH_CUSTOM lives in the home folder (Shell and dotfiles)
ARG OH_MY_ZSH_REF
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export GIT_SSL_CAINFO=/run/secrets/proxy_ca; fi; \
    git clone --filter=blob:none https://github.com/ohmyzsh/ohmyzsh.git /opt/oh-my-zsh \
 && git -C /opt/oh-my-zsh checkout --detach "${OH_MY_ZSH_REF}" && rm -rf /opt/oh-my-zsh/.git

# Agents and browser install before any Tempo file is copied, so a tempod change
# reuses their install layers.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g @agentclientprotocol/claude-agent-acp@0.89.1 && npm cache clean --force
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g @agentclientprotocol/codex-acp@2.2.2 && npm cache clean --force
# The postinstall links bin/opencode.exe to one platform package; drop the unused one.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g opencode-ai@1.18.35 && npm cache clean --force \
 && dir="$(npm root -g)/opencode-ai" \
 && for pkg in "$dir"/node_modules/opencode-linux-*; do \
      [ "$pkg/bin/opencode" -ef "$dir/bin/opencode.exe" ] || rm -rf "$pkg"; done \
 && opencode --version
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g @earendil-works/pi-coding-agent@1.1.0 pi-acp@0.0.34 && npm cache clean --force

ARG PLAYWRIGHT_MCP_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# @playwright/mcp bundles its own Playwright, so its CLI installs the Chromium build MCP launches.
# MCP runs full Chromium even with --headless, so the headless shell is not installed.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g playwright@1.61.1 @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} && npm cache clean --force \
 && if [ ! -e "$(npm prefix -g)/bin/mcp-server-playwright" ]; then \
      ln -s "$(npm prefix -g)/bin/playwright-mcp" "$(npm prefix -g)/bin/mcp-server-playwright"; fi \
 && node "$(npm root -g)/@playwright/mcp/node_modules/playwright-core/cli.js" install --with-deps --no-shell chromium \
 && chmod -R a+rwX /opt/ms-playwright \
 && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY dist/tempod /usr/local/bin/tempod
COPY container/home/ /home/tempo/
COPY container/home/ /etc/tempo/home-defaults/
COPY --chmod=0644 container/pi/tempo-profile.ts /opt/tempo/pi/tempo-profile.ts

RUN groupmod -n tempo node \
 && usermod -l tempo -d /home/tempo -s /bin/zsh node \
 && chmod 0755 /opt/tempo /opt/tempo/pi \
 && mkdir -p /workspace /home/tempo/.claude /home/tempo/.codex /home/tempo/.pi/agent /home/tempo/.oh-my-zsh-custom \
             /home/tempo/.local/share/opencode /home/tempo/.tempod /home/tempo/attachments \
 && chown -R tempo:tempo /workspace /home/tempo

ENV HOME=/home/tempo \
    LANG=C.UTF-8 \
    TERM=xterm-256color \
    GIT_TERMINAL_PROMPT=0 \
    CLAUDE_CONFIG_DIR=/home/tempo/.claude \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    IS_SANDBOX=1 \
    CODEX_HOME=/home/tempo/.codex \
    NO_BROWSER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_SHARE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

USER tempo
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tempod"]
