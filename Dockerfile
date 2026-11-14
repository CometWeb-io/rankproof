# RankProof CLI + HTTP API.
#
#   docker build -t rankproof .                        # verification, no browser
#   docker build -t rankproof:render --target render . # + headless Chromium
#
#   docker run --rm -v "$PWD:/work" rankproof verify /work/links.csv
#   docker run --rm -p 8787:8787 -e RANKPROOF_API_TOKEN=change-me rankproof api
#
# The web UI is not part of this image (it needs the full build); run it from
# a clone with `npm run dev` or `npm run build && npm run preview`.

FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production \
    RANKPROOF_PIN_DNS=1 \
    RANKPROOF_CACHE_DIR=/tmp/rankproof-cache
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies only: the engine needs `entities` and `tldts`.
RUN npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY bin ./bin
COPY scripts/load-dotenv.mjs scripts/node-version.mjs scripts/serve-api.mjs ./scripts/
COPY src/lib/backlinks ./src/lib/backlinks
COPY docker/entrypoint.sh /usr/local/bin/rankproof
RUN chmod +x /usr/local/bin/rankproof \
 && rm -rf src/lib/backlinks/*.test.ts \
 && mkdir -p /work && chown node:node /work
USER node
WORKDIR /work
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(process.env.RANKPROOF_MODE==='api'?1:0))"
ENTRYPOINT ["rankproof"]
CMD ["help"]

# Same image plus Playwright and Chromium for `--render` and RANKPROOF_RENDER=1.
# Run it on an isolated network: a browser resolves DNS itself (docs/production-ops.md).
FROM base AS render
USER root
WORKDIR /app
RUN npm install --no-save --no-audit --no-fund "playwright@$(node -p "require('./package.json').devDependencies.playwright.replace(/^[^0-9]*/, '')")" \
 && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install --with-deps chromium \
 && npm cache clean --force && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    RANKPROOF_RENDER=1
USER node
WORKDIR /work

FROM base AS default
