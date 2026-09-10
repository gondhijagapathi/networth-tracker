# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Net Worth Tracker
#
# Two images out of one file. `--target api` is the Node server; `--target web` is nginx
# serving the built front end and proxying `/api` to the server. That split mirrors the
# bare-metal deployment in docs/DEPLOYMENT.md rather than inventing a second architecture
# for containers: the API serves no HTML there and it serves none here.
#
# Build both with docker compose, or one by hand:
#
#     docker build --target api -t networth-api .
#     docker build --target web -t networth-web .
# ---------------------------------------------------------------------------

# Kept in step with .nvmrc, which is what CI builds against.
ARG NODE_VERSION=24


# ---------------------------------------------------------------------------
# Stage 1 — build everything, then drop the dev dependencies.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

# better-sqlite3 is a native module. Prebuilt binaries usually cover this platform, but a
# toolchain means a fall-back to compiling from source succeeds instead of failing the build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# husky's `prepare` script installs git hooks. There is no git repository in a build context
# and no use for hooks in an image.
ENV HUSKY=0

WORKDIR /app

# Manifests first, so a source-only change reuses the install layer. Every workspace named in
# package-lock.json has to be present or `npm ci` refuses to run.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/

RUN npm ci

COPY . .

RUN npm run build

# Leaves the compiled better-sqlite3 binding in place while removing typescript, vite and
# the rest. Cheaper and less error-prone than a second `npm ci --omit=dev`, which would have
# to rebuild the native module against the same toolchain all over again.
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Stage 2 — the API server.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS api

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    DATABASE_PATH=/data/networth.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups

WORKDIR /app

# The workspace layout is reproduced rather than flattened: `node_modules/@networth/shared`
# is a symlink into `packages/shared`, so that directory has to exist at the same path for
# the API's imports to resolve.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

# The migration runner resolves `../../migrations` from its own module URL and reads the
# plain .sql files at boot, so they are part of the runtime image, not just the build.
COPY --from=build /app/apps/api/migrations ./apps/api/migrations

# The mount point for the host directory that holds the database, the uploads and the
# backups. Compose bind-mounts over this and runs the container as the user who owns that
# directory on the host, so the ownership here only matters if somebody runs the image with
# no mount at all — in which case the data is ephemeral anyway.
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 4000

# No curl in a slim image, and no reason to add one when the runtime can make the request.
# `/api/health` needs no authentication and touches no user data.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT??4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entry point directly, not `npm start` — one less process between the init system and
# the server, so SIGTERM reaches the shutdown handler that checkpoints the WAL and closes
# the database cleanly.
CMD ["node", "apps/api/dist/index.js"]


# ---------------------------------------------------------------------------
# Stage 3 — the front end.
# ---------------------------------------------------------------------------
FROM nginx:1.29-alpine AS web

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
