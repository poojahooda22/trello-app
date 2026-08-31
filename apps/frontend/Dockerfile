# The web app. Build from the REPO ROOT:
#   docker build -f apps/frontend/Dockerfile -t trello-frontend .
#
# Bun's HTML server bundles at startup and inlines BUN_PUBLIC_* from the
# process environment (bunfig.toml). That is deliberate here: the API and
# WebSocket URLs are RUNTIME configuration, so the same image runs against any
# environment instead of being rebuilt per deployment.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

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
COPY apps/frontend ./apps/frontend
# The route tree is generated from the files in src/routes; a stale or missing
# one breaks every link, so it is regenerated rather than trusted from the host.
RUN cd apps/frontend && bun run generate-routes.ts

FROM oven/bun:1.3.14-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/apps/frontend ./apps/frontend

USER bun
WORKDIR /app/apps/frontend

EXPOSE 5173
CMD ["bun", "src/index.ts"]
