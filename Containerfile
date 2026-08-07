# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /workspace
COPY package.json bun.lock turbo.json tsconfig.json tsconfig.scripts.json tsconfig.infra.json ./
COPY apps/agent-run-worker ./apps/agent-run-worker
COPY apps/ingress ./apps/ingress
COPY apps/outbox-relay ./apps/outbox-relay
COPY apps/web ./apps/web
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run build

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
WORKDIR /srv/osfo
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/package.json ./package.json
RUN find /srv/osfo -type f -perm /022 -exec chmod go-w '{}' +
USER node
CMD ["node", "apps/ingress/dist/main.js"]
