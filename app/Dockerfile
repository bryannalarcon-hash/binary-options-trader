# Multi-stage Dockerfile for the Meridian web app (Next.js 15).
#
# Built from the *monorepo root* — Railway should be configured to deploy
# the repo root, with this Dockerfile path set to `app/Dockerfile`.
# Because the app imports `@meridian/types` as a pnpm workspace dep, we
# need the whole repo context (pnpm-workspace.yaml + packages/).

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
# Re-run pnpm install in the builder stage so pnpm's internal symlinks
# (which Docker COPY would mangle) are recreated from scratch alongside
# the source tree.
FROM base AS builder
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY app/package.json ./app/
COPY automation/package.json ./automation/
COPY tests/package.json ./tests/
RUN pnpm install --frozen-lockfile

# Now lay the app source on top.
COPY app/ ./app/

# Build shared types first, then the app.
RUN pnpm --filter @meridian/types build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter app build

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /repo
RUN apk add --no-cache libc6-compat \
 && corepack enable && corepack prepare pnpm@9.15.4 --activate \
 && addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Railway sets $PORT at runtime; default to 3000 if absent.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# Copy the built app + minimal runtime deps. We keep the workspace layout so
# `pnpm --filter app start` resolves @meridian/types from the workspace.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/app/node_modules ./app/node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml /repo/package.json ./
COPY --from=builder /repo/app/.next ./app/.next
COPY --from=builder /repo/app/public ./app/public
COPY --from=builder /repo/app/package.json ./app/
COPY --from=builder /repo/app/next.config.js ./app/

USER nextjs
WORKDIR /repo/app
# Use a shell so we can interpolate $PORT (Railway injects it).
# next start binds to $PORT if -p isn't passed; setting hostname to 0.0.0.0
# is needed for the container to accept external traffic.
CMD ["sh", "-c", "npx next start -p ${PORT:-3000} -H 0.0.0.0"]
