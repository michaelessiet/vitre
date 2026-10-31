# syntax=docker/dockerfile:1.7
FROM node:24.15.0-bookworm AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm --filter t3... --filter @t3tools/monorepo install --frozen-lockfile
RUN pnpm --dir apps/server run build:bundle
RUN --mount=type=cache,target=/root/.local/share/pnpm/store rm -rf infra/relay \
    && pnpm --filter t3 deploy --prod --legacy /tmp/vitre-cloud.worker/server \
    && node scripts/vitre/prune-packaged-node-modules.mjs /tmp/vitre-cloud.worker/server/node_modules \
    && mkdir -p /opt/vitre && mv /tmp/vitre-cloud.worker/server /opt/vitre/server
RUN node --input-type=module -e 'import { DEFAULT_MODEL_BY_PROVIDER } from "./packages/contracts/src/model.ts"; import { writeFileSync } from "node:fs"; writeFileSync("/opt/vitre/models.json", JSON.stringify(DEFAULT_MODEL_BY_PROVIDER));'

FROM node:24.15.0-bookworm-slim
ARG CODEX_VERSION
ARG CLAUDE_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl tar gzip procps python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.10.0 --activate
# Provider releases must be selected explicitly; never silently install latest.
RUN test -n "$CODEX_VERSION" && test -n "$CLAUDE_VERSION" \
    && npm install --global "@openai/codex@$CODEX_VERSION" "@anthropic-ai/claude-code@$CLAUDE_VERSION" \
    && npm cache clean --force
RUN case "$TARGETARCH" in \
      amd64) digest=5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886 ;; \
      arm64) digest=5a4e8ce2701105271412059f44b6a0bf1ae4542b4d98ff3180c0c019443a5815 ;; \
      *) exit 1 ;; \
    esac \
    && curl --fail --location "https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-linux-$TARGETARCH" -o /usr/local/bin/cloudflared \
    && printf '%s  %s\n' "$digest" /usr/local/bin/cloudflared | sha256sum --check \
    && chmod 755 /usr/local/bin/cloudflared
RUN useradd --uid 10001 --create-home --shell /bin/bash vitre \
    && useradd --uid 10002 --create-home --shell /bin/bash vitre-setup \
    && mkdir -p /workspace /var/lib/vitre-worker /opt/vitre/cloud \
    && chmod 700 /var/lib/vitre-worker
COPY --from=build /opt/vitre/server /opt/vitre/server
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/vitre/browsers
RUN node /opt/vitre/server/node_modules/playwright-core/cli.js install --with-deps chromium \
    && chmod -R a+rX /opt/vitre/browsers \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/vitre/models.json /opt/vitre/cloud/models.json
COPY scripts/vitre/cloud/*.mjs /opt/vitre/cloud/
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/vitre/cloud/worker.mjs"]
