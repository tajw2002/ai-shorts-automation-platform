# syntax=docker/dockerfile:1
#
# Dashboard image. Uses Next.js standalone output so the runtime layer carries
# only the server and the files it actually needs.

FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --workspace @shorts/contracts --workspace @shorts/web --include-workspace-root

FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web

RUN npm run build --workspace @shorts/contracts \
 && npm run build --workspace @shorts/web

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

USER node
EXPOSE 8080

CMD ["node", "apps/web/server.js"]
