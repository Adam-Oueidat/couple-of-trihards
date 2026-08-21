# syntax=docker/dockerfile:1

# Debian (glibc) rather than Alpine: @libsql/client ships native bindings that
# are awkward to source on musl. Node 22 is the active LTS (20 is EOL).
# Keep this major in sync with .nvmrc, which CI reads via node-version-file.
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable

# Install against the lockfile first so dependency layers cache independently
# of source churn.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
RUN pnpm install --frozen-lockfile

COPY . .

# Non-secret placeholders, mirroring .github/workflows/ci.yml. `next build`
# makes no DB or API calls; these are only read inside functions that aren't
# invoked at build time. Real values are injected by App Runner at runtime.
ENV SESSION_SECRET=build-placeholder-session-secret-0123456789 \
    STRAVA_CLIENT_ID=build \
    STRAVA_CLIENT_SECRET=build \
    STRAVA_REDIRECT_URI=http://localhost:3000/api/auth/callback \
    TURSO_DATABASE_URL=file:./build.db \
    ANTHROPIC_API_KEY=build \
    ADMIN_ATHLETE_IDS="" \
    MOBILE_DEEP_LINK_SCHEME=trilog
RUN pnpm --filter @trihards/web build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
RUN useradd --create-home --shell /usr/sbin/nologin nextjs

# outputFileTracingRoot is the monorepo root, so the standalone tree mirrors the
# repo layout: server.js sits under apps/web with node_modules hoisted to /app.
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/.next/standalone ./
# standalone deliberately omits these two; copy them so server.js can serve them.
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
# Next's standalone server binds to $HOSTNAME. Container runtimes inject their
# own HOSTNAME (the instance's name), which an ENV default cannot outrank -- the
# server then listens on one interface while the platform health-checks another.
# Setting it in the exec line wins over anything the runtime provides.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node apps/web/server.js"]
