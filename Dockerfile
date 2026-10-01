# API + workers run TypeScript directly on Node 24 (type stripping): no build step for them.
# Only the dashboard is built (Vite), in a throwaway stage.
# Never use `pnpm deploy` for the runtime: it copies workspace packages into node_modules,
# where Node refuses to strip types.

FROM node:24-slim AS dashboard
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm --filter @instantlead/dashboard build

FROM node:24-slim
ENV NODE_ENV=production COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --prod
COPY . .
RUN pnpm install --offline --prod --frozen-lockfile
COPY --from=dashboard /app/apps/dashboard/dist apps/dashboard/dist
USER node
EXPOSE 3000
CMD ["node", "apps/api/src/main.ts"]
