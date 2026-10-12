# syntax=docker/dockerfile:1
#
# Shade backend image: one image, two processes (API and worker).
# Build from the repository root (the npm workspace lockfile lives there):
#
#   docker build -f backend/Dockerfile -t shade-backend .
#   docker run --env-file backend/.env -p 8787:8787 shade-backend            # API
#   docker run --no-healthcheck --env-file backend/.env --env-file backend/.env.worker \
#     shade-backend node src/bin/worker.ts
#
# The last line is the worker (it serves no HTTP, so the /healthz HEALTHCHECK is for the API only). Only it gets backend/.env.worker, which holds the seal private key
# (VIEWING_KEY_SEAL_PRIVATE_KEYS); the API never does (agents.md §5.3). See backend/.env.example.
#
# Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:24-bookworm-slim

# The native viewing-key scanner reads the system CA bundle for its TLS connections to lightwalletd.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# npm ci validates the lockfile against every workspace manifest, then installs only the backend's
# runtime dependencies. --omit=optional also drops test tooling that reaches the tree as optional
# peers (vitest, vite); no backend runtime package needs an optional or install-script dependency.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY backend/sdk/package.json backend/sdk/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --omit=optional --workspace=@shade/backend --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY backend/migrations backend/migrations
COPY backend/src backend/src

WORKDIR /app/backend
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/bin/server.ts"]
