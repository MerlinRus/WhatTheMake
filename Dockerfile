FROM node:24.19.0-alpine3.24 AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/infrastructure/package.json packages/infrastructure/package.json
RUN npm ci

COPY tsconfig.json tsconfig.base.json eslint.config.js ./
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/contracts packages/contracts
COPY packages/domain packages/domain
COPY packages/infrastructure packages/infrastructure
RUN npm run build

FROM build AS verification
RUN npm run typecheck
RUN npm run lint
RUN npm test

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:24.19.0-alpine3.24 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server/package.json ./apps/server/package.json
COPY --from=production-dependencies /app/apps/server/dist ./apps/server/dist
COPY --from=production-dependencies /app/apps/server/migrations ./apps/server/migrations
COPY --from=production-dependencies /app/apps/web/package.json ./apps/web/package.json
COPY --from=production-dependencies /app/apps/web/dist ./apps/web/dist
COPY --from=production-dependencies /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=production-dependencies /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=production-dependencies /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=production-dependencies /app/packages/domain/dist ./packages/domain/dist
COPY --from=production-dependencies /app/packages/infrastructure/package.json ./packages/infrastructure/package.json
COPY --from=production-dependencies /app/packages/infrastructure/dist ./packages/infrastructure/dist
RUN node --input-type=module -e "await Promise.all([import('@wtm/contracts'), import('@wtm/domain'), import('@wtm/infrastructure')])"
RUN mkdir -p /var/lib/whatthemake/media && chown -R node:node /var/lib/whatthemake

USER node
EXPOSE 8787
CMD ["node", "apps/server/dist/server.js"]

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS e2e

WORKDIR /app
COPY . .
RUN npm ci

CMD ["npm", "run", "test:e2e"]
