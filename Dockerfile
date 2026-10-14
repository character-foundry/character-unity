FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.20.0
WORKDIR /build/character-unity
COPY . .
# Fetch the public SDK at foundry-sdk.json's exact commit. Neither the SDK nor
# node_modules is copied from a developer machine.
# A fresh build remains gated until that pinned Foundry commit is published.
RUN pnpm bootstrap && pnpm build && pnpm build:browser
RUN node scripts/stage-node-runtime.mjs /output

FROM build AS archive-build
RUN node scripts/stage-node-runtime.mjs /archive-output archive

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS archive
ENV NODE_ENV=production HOST=127.0.0.1 PORT=9313 UNITY_ARCHIVE_MODE=off
WORKDIR /app
COPY --from=archive-build /archive-output/ ./
RUN chmod -R a+rX /app && mkdir /data && chown node:node /data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node.js"]

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=9312 UNITY_PROFILE=hub \
    UNITY_DB_PATH=/data/unity.db UNITY_BLOB_DIR=/data/blobs UNITY_WEB_DIR=/app/web/unity
WORKDIR /app
COPY --from=build /output/ ./
RUN chmod -R a+rX /app && mkdir /data && chown node:node /data
USER node
EXPOSE 9312
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node.js"]
