# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS dependencies
WORKDIR /app

# Native modules and Prisma's OpenSSL detection both require these on Alpine.
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS build
WORKDIR /app
COPY . .
RUN npm run prisma:generate \
    && npm run build

FROM build AS migration
ENV HOME=/tmp \
    NPM_CONFIG_CACHE=/tmp/.npm
USER node
CMD ["npm", "run", "prisma:migrate"]

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache dumb-init libc6-compat openssl \
    && chown node:node /app

ENV NODE_ENV=production \
    PORT=3000

COPY --chown=node:node --from=production-dependencies /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
