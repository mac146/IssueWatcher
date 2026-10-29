# syntax=docker/dockerfile:1
#
# Two images come from this file:
#   docker build -t issue-watcher .                    the email digest (default target, the last stage)
#   docker build --target mcp -t issuewatcher-mcp .    the MCP server (speaks MCP over stdio: run with -i)
#
# The default target must stay LAST, because that is what a plain `docker build` produces.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# The lean MCP package: only the files the server imports and only the dependencies it needs.
FROM build AS mcp-package
RUN npm run package:mcp

FROM node:22-alpine AS mcp
ENV NODE_ENV=production \
    ISSUEWATCHER_CACHE_DIR=/data
WORKDIR /app
COPY --from=mcp-package /app/dist-mcp/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=mcp-package /app/dist-mcp/build ./build
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
# Pass GITHUB_TOKEN with -e. `docker run -i --rm -e GITHUB_TOKEN issuewatcher-mcp --check` tests the setup.
ENTRYPOINT ["node", "build/mcp/main.js"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    STATE_FILE=/data/state.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Tests are compiled alongside the app; they are not needed at runtime.
COPY --from=build /app/build ./build
RUN rm -rf build/__tests__ \
    && mkdir /data && chown node:node /data
USER node
VOLUME /data
CMD ["node", "build/index.js"]
