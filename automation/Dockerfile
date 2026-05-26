# Multi-stage Dockerfile for the Meridian automation service.
#
# Built from the *monorepo root* — Railway should be configured to deploy
# the repo root, with this Dockerfile path set to `automation/Dockerfile`.

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# ---- deps ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY app/package.json ./app/
COPY automation/package.json ./automation/
COPY tests/package.json ./tests/
RUN pnpm install --frozen-lockfile

# ---- builder ----
FROM base AS builder
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY app/package.json ./app/
COPY automation/package.json ./automation/
COPY tests/package.json ./tests/
RUN pnpm install --frozen-lockfile

COPY automation/ ./automation/
# IDL lives under app/lib/meridian-idl.json — automation reads it.
COPY app/lib/meridian-idl.json ./app/lib/meridian-idl.json

RUN pnpm --filter @meridian/types build
RUN pnpm --filter automation build

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /repo
RUN apk add --no-cache libc6-compat \
 && corepack enable && corepack prepare pnpm@9.15.4 --activate \
 && addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 service

ENV NODE_ENV=production
# Railway injects $PORT; src/env.ts mirrors it onto AUTOMATION_HEALTH_PORT.

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/automation/node_modules ./automation/node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml /repo/package.json ./
COPY --from=builder /repo/automation/dist ./automation/dist
COPY --from=builder /repo/automation/package.json ./automation/
COPY --from=builder /repo/app/lib/meridian-idl.json ./app/lib/meridian-idl.json

USER service
WORKDIR /repo/automation

# Expose the health server port (Railway maps the platform PORT).
EXPOSE 3001
CMD ["node", "dist/index.js"]
