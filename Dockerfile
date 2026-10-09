# Railway runs the API, web bundle, and exported Fumadocs site as one service.
# Keep the build inputs explicit so local node_modules, customer references, and
# generated output never become part of the Docker build context.
FROM oven/bun:1.3.8 AS dependencies

WORKDIR /app

COPY package.json bun.lock ./
COPY richtfest-shared/package.json ./richtfest-shared/package.json
COPY richtfest-os/apps/api/package.json ./richtfest-os/apps/api/package.json
COPY richtfest-os/apps/docs/package.json ./richtfest-os/apps/docs/package.json
COPY richtfest-os/apps/web/package.json ./richtfest-os/apps/web/package.json
COPY richtfest-apps/crm/package.json ./richtfest-apps/crm/package.json
COPY richtfest-apps/knowledge/package.json ./richtfest-apps/knowledge/package.json
COPY richtfest-apps/projects/package.json ./richtfest-apps/projects/package.json

# Fumadocs uses platform-optional native parsing bindings. Install the Linux
# variants for both Railway's x64 builders and local ARM64 Docker builders.
RUN bun install --frozen-lockfile --linker=hoisted --os=linux --cpu='*'

FROM dependencies AS build

# Next.js' static exporter currently trips Bun's Linux build worker while
# collecting the generated _not-found page. Use the Node runtime shipped by
# Debian for this one build step; the service still installs and runs on Bun.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY . .

# Shared, API, and app packages are TypeScript source packages. Their typecheck
# is the build gate; the web and docs packages emit the two served bundles.
RUN bun run typecheck
RUN bun run --filter @richtfest/web build
RUN cd richtfest-os/apps/docs && /app/node_modules/.bin/next build --webpack

FROM oven/bun:1.3.8 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/richtfest-shared/package.json ./richtfest-shared/package.json
COPY --from=build /app/richtfest-shared/src ./richtfest-shared/src
COPY --from=build /app/richtfest-apps ./richtfest-apps
COPY --from=build /app/richtfest-os/apps/api ./richtfest-os/apps/api
COPY --from=build /app/richtfest-os/apps/web/dist ./richtfest-os/apps/web/dist
COPY --from=build /app/richtfest-os/apps/docs/out ./richtfest-os/apps/docs/out

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'

# Railway injects DATABASE_URL and the other runtime variables. Migrations are
# applied against that database before the API starts serving traffic.
CMD ["sh", "-c", "cd /app/richtfest-os/apps/api && bun run db:migrate && exec bun src/index.ts"]
