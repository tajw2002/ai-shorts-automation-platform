# syntax=docker/dockerfile:1
#
# Multi-stage build for the API.
#
# The same image runs as `api` or `worker` — only APP_ROLE differs — so there is
# one artefact to build, scan and promote, and no chance of the two drifting apart.

# ---- Stage 1: install dependencies -------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Copy only manifests first so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --workspace @shorts/contracts --workspace @shorts/api --include-workspace-root

# ---- Stage 2: build ----------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api

RUN npm run build --workspace @shorts/contracts \
 && npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build --workspace @shorts/api

# Drop dev dependencies from the tree that will be copied into the runtime image.
RUN npm prune --omit=dev --workspace @shorts/contracts --workspace @shorts/api --include-workspace-root

# ---- Stage 3: runtime --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg is a hard requirement of the media pipeline; ca-certificates is needed
# for outbound TLS to the provider APIs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    APP_ROLE=all \
    PORT=8080 \
    LOCAL_STORAGE_ROOT=/data/storage

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

# A writable scratch area for renders, owned by the unprivileged user.
RUN mkdir -p /data/storage && chown -R node:node /data

# Never run as root: a compromise in ffmpeg or a dependency should not be root.
USER node

EXPOSE 8080

# Cloud Run performs its own health checking, but this keeps `docker run` honest.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
