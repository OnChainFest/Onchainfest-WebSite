# syntax=docker/dockerfile:1.7
#
# LAUNCH-02 · Provider-neutral container images for the OnChainFest API and worker.
#
#   docker build --target api    -t onchainfest-api .
#   docker build --target worker -t onchainfest-worker .
#   docker build --target web    -t onchainfest-web --build-arg NEXT_PUBLIC_…=… .   (STG-01A)
#
# Both run TypeScript through tsx: the workspace has no compile step, and tsx is the runtime both
# `start` scripts already use. The image therefore installs the workspace's full dependency set
# from the frozen lockfile. No secret or environment value is baked in. Every credential arrives
# at run time (docs/operations/LAUNCH-02-PRODUCTION-RUNBOOK.md).
# One-off operator commands (migrations, bootstrap, catalog, result authority) run in the `api`
# image with an overridden command, for example:
#   docker run --rm -e NODE_ENV=production -e BR_OWNER_DATABASE_URL=… onchainfest-api \
#     node --import tsx packages/persistence/src/cli/migrate.ts

FROM node:22.20.0-bookworm-slim AS workspace
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && chown -R node:node /app
USER node
ENV NODE_ENV=production

# STG-01A · Next.js tournament web app (`docker build --target web`). Next.js inlines NEXT_PUBLIC_*
# values at build time, so the image is specific to one environment: build it with that
# environment's public values (publishable only, never a service-role key). They are passed again
# at run time for the server. Uses the `next` binary directly so no package manager runs at start.
FROM workspace AS web
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MARKETING_URL=https://www.onchainfest.xyz
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/web
RUN node_modules/.bin/next build
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]

FROM workspace AS api
ENV HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080
# Liveness only; orchestrators should also gate traffic on GET /ready (database + migrations).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]

FROM workspace AS worker
# Preflight (configuration, database, migrations): node --import tsx apps/worker/src/main.ts --check
CMD ["node", "--import", "tsx", "apps/worker/src/main.ts"]
