import { buildApp } from './app.ts';
import { loadEnv } from './env.ts';
import { decorateRequests, registerAuthRoutes } from './http/auth.ts';
import { registerRoutes } from './http/routes.ts';
import { createAppContext } from './system/context.ts';

const env = loadEnv();
const ctx = createAppContext(env);
const app = buildApp({ logLevel: env.LOG_LEVEL, checkDb: ctx.checkDb });
decorateRequests(app);
registerAuthRoutes(app, ctx);
registerRoutes(app, ctx);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await ctx.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
