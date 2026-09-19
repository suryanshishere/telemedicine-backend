# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS dependencies
WORKDIR /app

# Native modules and Prisma's OpenSSL detection both require these on Alpine.
RUN apk add --no-cache libc6-compat openssl

# npm ci runs the postinstall Prisma generation, so the schema must already be
# available while keeping application sources out of the dependency layer.
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS build
WORKDIR /app
COPY . .
RUN npm run prisma:generate \
    && npm run build

FROM build AS migration
ENV HOME=/tmp
# The one-shot image invokes the checked-in Prisma CLI directly. Removing npm and
# the full lockfile avoids shipping package-manager code and stale lock metadata.
RUN rm -f /app/package-lock.json \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache dumb-init libc6-compat openssl \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && chown node:node /app

ENV NODE_ENV=production \
    PORT=3000

COPY --chown=node:node --from=production-dependencies /app/package.json ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
