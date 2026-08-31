

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

# Manifests first: this layer is cached until a dependency actually changes.
COPY package.json bun.lock ./
# Every workspace in bun.lock, not just the ones this app imports: bun compares
# the whole workspace set against the lockfile, and a missing member makes
# --frozen-lockfile fail. Add a line here when a new workspace is added.
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/websockets/package.json ./apps/websockets/
COPY packages/db/package.json ./packages/db/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/typescript-config/package.json ./packages/typescript-config/
COPY packages/ui/package.json ./packages/ui/
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY packages/db ./packages/db
COPY apps/websockets ./apps/websockets
# db/client re-exports ./generated/prisma, which only exists after this runs.
RUN cd packages/db && bunx prisma generate

FROM oven/bun:1.3.14-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

# bun's image already provides a non-root `bun` user. Running as root would
# give an escaped process ownership of the whole filesystem for free.
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/packages/db ./packages/db
COPY --from=build --chown=bun:bun /app/apps/websockets ./apps/websockets

USER bun
WORKDIR /app/apps/websockets

# 3002 is the browser-facing WebSocket; 3003 is the internal endpoint the
# backend calls. Only 3002 should ever be published outside the compose network.
EXPOSE 3002 3003
CMD ["bun", "index.ts"]
