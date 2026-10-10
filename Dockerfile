# Railway runs the API, web bundle, and exported Fumadocs site as one service.
# Keep the build inputs explicit so local node_modules, customer references, and
# generated output never become part of the Docker build context.
# Docker Hub rate-limits shared builders. The public mirror serves the same
# upstream Bun 1.3.8 multi-architecture digest; do not use an unpinned mirror tag.
FROM mirror.gcr.io/oven/bun:1.3.8@sha256:371d30538b69303ced927bb5915697ac7e2fa8cb409ee332c66009de64de5aa3 AS bun

FROM bun AS manifests

WORKDIR /app

COPY package.json bun.lock ./
COPY richtfest-shared/package.json ./richtfest-shared/package.json
COPY richtfest-os/apps/api/package.json ./richtfest-os/apps/api/package.json
COPY richtfest-os/apps/docs/package.json ./richtfest-os/apps/docs/package.json
COPY richtfest-os/apps/web/package.json ./richtfest-os/apps/web/package.json
COPY richtfest-apps/crm/package.json ./richtfest-apps/crm/package.json
COPY richtfest-apps/knowledge/package.json ./richtfest-apps/knowledge/package.json
COPY richtfest-apps/projects/package.json ./richtfest-apps/projects/package.json

FROM manifests AS dependencies

# Install native bindings for the builder's Linux architecture, not every CPU.
# Use the isolated linker, as in local development: workspaces depend on
# different zod majors, and hoisting resolves peer dependencies (e.g. the web
# app's OpenUI library) against the wrong one.
RUN bun install --frozen-lockfile --linker=isolated

FROM manifests AS production-dependencies
RUN bun install --frozen-lockfile --linker=isolated --production

FROM dependencies AS sources

# Only build inputs invalidate these layers. Rules, Railway config and other
# repository metadata must not rebuild every application.
COPY tsconfig.json ./
COPY richtfest-shared ./richtfest-shared
COPY richtfest-apps ./richtfest-apps
COPY richtfest-os/apps/api ./richtfest-os/apps/api
COPY tests ./tests

FROM sources AS checked
COPY richtfest-os/apps/web ./richtfest-os/apps/web
COPY richtfest-os/apps/docs ./richtfest-os/apps/docs
RUN bun run typecheck

FROM sources AS web
COPY richtfest-os/apps/web ./richtfest-os/apps/web
RUN bun run --filter @richtfest/web build

FROM dependencies AS docs

# Next.js' static exporter currently trips Bun's Linux build worker while
# collecting the generated _not-found page. Use the Node runtime shipped by
# Debian for this one build step; the service still installs and runs on Bun.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY richtfest-os/apps/docs ./richtfest-os/apps/docs
RUN cd richtfest-os/apps/docs && node_modules/.bin/next build --webpack

FROM bun AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=checked /app/package.json ./package.json
COPY --from=production-dependencies /app/richtfest-shared ./richtfest-shared
COPY --from=checked /app/richtfest-shared/src ./richtfest-shared/src
COPY --from=production-dependencies /app/richtfest-os/apps/api ./richtfest-os/apps/api
COPY --from=checked /app/richtfest-apps ./richtfest-apps
COPY --from=checked /app/richtfest-os/apps/api/src ./richtfest-os/apps/api/src
COPY --from=checked /app/richtfest-os/apps/api/drizzle ./richtfest-os/apps/api/drizzle
COPY --from=checked /app/richtfest-os/apps/api/drizzle.config.ts ./richtfest-os/apps/api/drizzle.config.ts
COPY --from=web /app/richtfest-os/apps/web/dist ./richtfest-os/apps/web/dist
COPY --from=docs /app/richtfest-os/apps/docs/out ./richtfest-os/apps/docs/out
COPY richtfest-landing ./richtfest-landing

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'

# Railway injects DATABASE_URL and the other runtime variables. Migrations are
# applied against that database before the API starts serving traffic.
CMD ["sh", "-c", "cd /app/richtfest-os/apps/api && bun run db:migrate && exec bun src/index.ts"]
