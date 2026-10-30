# cc-node-agent (TRD 14.2): reports a Linux host and its compose services to the monitor.
# Built by .github/workflows/images.yml from the repository root:
#   docker build -f apps/node-agent/Dockerfile -t cc-node-agent .
# The agent has no runtime dependencies (types only from @cc/shared), so the final image is Node
# plus the compiled files.

FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/node-agent/package.json apps/node-agent/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @cc/node-agent...
COPY packages/shared packages/shared
COPY apps/node-agent apps/node-agent
RUN pnpm --filter @cc/shared build && pnpm --filter @cc/node-agent build

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/administrator-cpu/monitor" \
      org.opencontainers.image.description="Command Center node agent: host and container metrics for the monitor" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/apps/node-agent/package.json ./
COPY --from=build /src/apps/node-agent/dist ./dist
# The state volume (host token) is created owned by the agent's user, so a fresh named volume
# starts writable for it; nothing else in the container is writable (read_only in compose).
RUN mkdir -p /var/lib/cc-agent && chown 10001:10001 /var/lib/cc-agent && chmod 700 /var/lib/cc-agent
USER 10001:10001
ENTRYPOINT ["node", "dist/main.js"]
