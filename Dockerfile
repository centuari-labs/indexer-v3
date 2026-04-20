# ---------- builder ----------
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /repo

# Copy the workspace manifest + every service's package.json so pnpm can
# compute the dep graph. The COPY globs below assume the build context is
# the repo root (see docker-compose context: .).
COPY pnpm-workspace.yaml package.json* pnpm-lock.yaml* ./
COPY indexer-v3/package.json ./indexer-v3/
COPY backend-v2/package.json ./backend-v2/
COPY settlement-engine/package.json ./settlement-engine/
COPY matching-engine/package.json ./matching-engine/
COPY frontend-revamp/package.json ./frontend-revamp/

RUN pnpm install --frozen-lockfile --filter @centuari/indexer-v3...

COPY indexer-v3 ./indexer-v3

WORKDIR /repo/indexer-v3
RUN pnpm run build

# Produce a deployable tree containing only the indexer and its deps.
RUN pnpm deploy --filter @centuari/indexer-v3 --prod /prod-out

# ---------- production ----------
FROM node:22-alpine AS production

WORKDIR /app

COPY --from=builder /prod-out ./

ENV NODE_ENV=production
ENV TZ=UTC

EXPOSE 42069

CMD ["node", "dist/index.js"]
