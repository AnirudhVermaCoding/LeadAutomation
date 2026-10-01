# Runs TypeScript directly on Node 24 (type stripping) — no build step for the API.
# Never use `pnpm deploy` here: it copies workspace packages into node_modules,
# where Node refuses to strip types.
FROM node:24-slim
ENV NODE_ENV=production COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --prod
COPY . .
RUN pnpm install --offline --prod --frozen-lockfile
USER node
EXPOSE 3000
CMD ["node", "apps/api/src/main.ts"]
