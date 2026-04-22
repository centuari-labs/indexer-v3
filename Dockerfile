# syntax=docker/dockerfile:1.7
# ---------- builder ----------
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# .npmrc holds the @centuari-labs scope -> GitHub Packages mapping (no token).
# Auth token is provided at install time via BuildKit secret mount.
COPY package.json pnpm-lock.yaml .npmrc ./

RUN --mount=type=secret,id=npmrc,dst=/root/.npmrc \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

# ---------- production ----------
FROM node:22-alpine AS production

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./

RUN --mount=type=secret,id=npmrc,dst=/root/.npmrc \
    pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV TZ=UTC

EXPOSE 42069

CMD ["node", "dist/index.js"]
