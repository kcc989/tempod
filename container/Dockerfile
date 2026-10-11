# The `workspace` image (01, Container image). Versions live in container/versions.json;
# `bun run check:versions` fails when this file and versions.json disagree.
# BASE_IMAGE is pinned by digest at build time (container/pin-base.ts writes the digest).
ARG BASE_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
FROM ${BASE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates git ripgrep fd-find tmux inotify-tools curl jq unzip zstd \
    procps iproute2 python3 python3-venv build-essential libnss3-tools \
 && rm -rf /var/lib/apt/lists/*

# gh and bun: versions from versions.json, passed as build args
ARG GH_VERSION
ARG BUN_VERSION
RUN curl -fsSL https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz \
    | tar -xz -C /tmp && mv /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"
RUN corepack enable

ARG PLAYWRIGHT_MCP_VERSION
RUN npm install -g \
    @agentclientprotocol/claude-agent-acp@0.89.1 \
    @agentclientprotocol/codex-acp@2.2.2 \
    opencode-ai@1.18.35 \
    @earendil-works/pi-coding-agent@1.1.0 \
    pi-acp@0.0.34 \
    playwright@1.61.1 \
    @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}

# @playwright/mcp 0.0.83 names its bin `playwright-mcp`; 01 calls it `mcp-server-playwright`.
# Keep both until spike S7 settles the name (docs/IMPLEMENTATION_NOTES.md).
RUN if [ ! -e "$(npm prefix -g)/bin/mcp-server-playwright" ]; then \
      ln -s "$(npm prefix -g)/bin/playwright-mcp" "$(npm prefix -g)/bin/mcp-server-playwright"; fi

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN playwright install --with-deps chromium && chmod -R a+rwX /opt/ms-playwright

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY dist/tempod /usr/local/bin/tempod
COPY container/home/ /home/tempo/

RUN useradd -m -u 1000 -s /bin/bash tempo \
 && mkdir -p /workspace /home/tempo/.claude /home/tempo/.codex /home/tempo/.pi/agent \
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
ENTRYPOINT ["/usr/local/bin/tempod"]
