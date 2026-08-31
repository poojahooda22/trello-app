# The API and GitHub webhook receiver. Build from the REPO ROOT:
#   docker build -f apps/backend/Dockerfile -t trello-backend .

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/websockets/package.json ./apps/websockets/
COPY packages/db/package.json ./packages/db/
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY packages/db ./packages/db
COPY apps/backend ./apps/backend
RUN cd packages/db && bunx prisma generate

FROM oven/bun:1.3.14-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/packages/db ./packages/db
COPY --from=build --chown=bun:bun /app/apps/backend ./apps/backend

USER bun
WORKDIR /app/apps/backend

# The code falls back to 3000 when PORT is unset; pin it so the port the
# image exposes, the healthcheck and the Caddyfile all agree.
ENV PORT=3001
EXPOSE 3001
# The app answers /health with {ok:true}; compose uses it to order startup.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT??3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "index.ts"]
