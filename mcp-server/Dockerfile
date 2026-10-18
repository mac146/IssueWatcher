# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

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
