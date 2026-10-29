FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build
WORKDIR /app
ARG YARN_HTTP_PROXY
ARG YARN_HTTPS_PROXY
RUN npm install --global corepack@0.34.1 && corepack prepare yarn@4.10.3 --activate
COPY package.json yarn.lock .yarnrc.yml tsconfig.json ./
COPY vendor ./vendor
COPY apps/server/package.json ./apps/server/package.json
COPY apps/teacher/package.json ./apps/teacher/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/client-sdk/package.json ./packages/client-sdk/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN yarn install --immutable --mode=skip-build
COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.build.json ./apps/server/tsconfig.build.json
COPY packages/protocol ./packages/protocol
COPY packages/domain ./packages/domain
RUN yarn build:server && yarn workspaces focus @record/server --production

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server ./apps/server
COPY --from=build --chown=node:node /app/packages/protocol ./packages/protocol
COPY --from=build --chown=node:node /app/packages/domain ./packages/domain
RUN mkdir -p /data/api-spool /data/cursors && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node","apps/server/dist/main.js"]
