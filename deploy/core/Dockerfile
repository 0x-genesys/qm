FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS wireproxy-build

RUN apk add --no-cache go \
  && CGO_ENABLED=0 GOBIN=/out go install github.com/windtf/wireproxy/cmd/wireproxy@v1.1.2

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS connector-sdk-build
WORKDIR /app
COPY deploy/connector-sdk ./deploy/connector-sdk
RUN npm ci --prefix deploy/connector-sdk --ignore-scripts --no-audit --no-fund \
  && node deploy/connector-sdk/build.mjs

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS web-ui-build
WORKDIR /app/plugins/web-ui
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci
COPY plugins/web-ui/index.html plugins/web-ui/shared.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/public ./public
COPY plugins/web-ui/src ./src
COPY plugins/chassis/src /app/plugins/chassis/src
COPY docs/images/slack-app-config-token-setup.gif /app/docs/images/slack-app-config-token-setup.gif
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache ca-certificates curl git git-daemon docker-cli

COPY --from=wireproxy-build /out/wireproxy /usr/local/bin/wireproxy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm run audit:prod \
  && rm -rf /root/.npm /tmp/node-compile-cache

COPY --from=connector-sdk-build /app/.generated/connector-sdk ./.generated/connector-sdk
COPY src ./src
COPY cli/src/canonical-json.ts cli/src/credential-paths.ts cli/src/scope-storage-key.ts cli/src/tool-descriptor.ts ./cli/src/
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis
COPY plugins/admin/package.json plugins/admin/package-lock.json ./plugins/admin/
RUN npm ci --prefix plugins/admin --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/admin/src ./plugins/admin/src
COPY plugins/admin/ui ./plugins/admin/ui
COPY plugins/admin/public ./plugins/admin/public
COPY plugins/auth/src ./plugins/auth/src
COPY plugins/portal/src ./plugins/portal/src
COPY plugins/web-ui/server ./plugins/web-ui/server
COPY plugins/web-ui/src ./plugins/web-ui/src
COPY --from=web-ui-build /app/plugins/web-ui/dist-web ./plugins/web-ui/dist-web
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV DATA_DIR=/data
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080

RUN apk add --no-cache util-linux
USER node
CMD ["node", "src/index.ts"]
