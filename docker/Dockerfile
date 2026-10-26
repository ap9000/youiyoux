# The team's hosted hub, `youiyoux hub serve`, installed from the npm package's own tarball: built
# by `pnpm docker` (scripts/docker.ts) and by the release workflow from the tarball it publishes,
# so the image holds exactly what npm does. Run it: docs/self-hosting.md.
#
# Build context: a directory holding youiyoux.tgz and nothing else (scripts/docker.ts makes it).
FROM node:24.22.1-bookworm-slim

WORKDIR /app
COPY youiyoux.tgz /tmp/youiyoux.tgz
# pg: the Postgres driver the bundle leaves out (DATABASE_URL), the version @youiyoux/store pins.
RUN npm install --omit=dev --no-audit --no-fund --no-update-notifier /tmp/youiyoux.tgz pg@8.23.1 \
 && rm /tmp/youiyoux.tgz \
 && npm cache clean --force \
 && mkdir /data \
 && chown node:node /data

# Without DATABASE_URL, records are kept in a SQLite file on the /data volume.
ENV NODE_ENV=production \
    PORT=8080 \
    YOUI_HUB_DB=/data/hub.db \
    PATH=/app/node_modules/.bin:$PATH
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["youiyoux", "hub", "serve", "--host", "0.0.0.0"]
