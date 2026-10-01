import { buildApp } from './app.ts';
import { loadEnv } from './env.ts';
import { registerHttp } from './http/index.ts';
import { createAppContext } from './system/context.ts';
import { startWorkers } from './workers.ts';

const env = loadEnv();
const ctx = createAppContext(env);
const app = buildApp({ logLevel: env.LOG_LEVEL, checkDb: ctx.checkDb });
await registerHttp(app, ctx);
await ctx.start();
if (env.ROLE !== 'api') await startWorkers(ctx, app.log);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await ctx.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
