# Safyr Deal Terminal — single image, many entrypoints.
# The web app, each ingestion worker, the classifier, and the ws server all
# run from this one image; docker-compose wires them up with different
# commands.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Keep the full node_modules — the worker processes use tsx at runtime.
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/.next         ./.next
COPY --from=build /app/public        ./public
COPY --from=build /app/app           ./app
COPY --from=build /app/lib           ./lib
COPY --from=build /app/workers       ./workers
COPY --from=build /app/scripts       ./scripts
COPY --from=build /app/db            ./db
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/package.json  ./package.json

# Default command is the Next.js web server; docker-compose overrides it for
# worker containers. PORT respects standard conventions.
EXPOSE 3000 3030
CMD ["npx", "next", "start", "-p", "3000"]
