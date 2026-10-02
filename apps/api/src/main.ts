import { buildApp } from './app.ts';
import { loadEnv } from './env.ts';
import { captureError, initErrorTracking } from './sentry.ts';
import { registerHttp } from './http/index.ts';
import { createAppContext } from './system/context.ts';
import { startWorkers } from './workers.ts';

const env = loadEnv();
await initErrorTracking(env);
const ctx = createAppContext(env);
const app = buildApp({
  logLevel: env.LOG_LEVEL,
  checkDb: ctx.checkReady,
  trustProxy: env.TRUST_PROXY,
});
await registerHttp(app, ctx);
await ctx.start();
if (env.ROLE !== 'api') await startWorkers(ctx, app.log);

let stopping = false;
async function shutdown(signal: string, code = 0) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  // Docker waits stop_grace_period (30 s) before SIGKILL: finish in-flight requests and jobs, but never hang.
  const watchdog = setTimeout(() => {
    app.log.error('graceful shutdown took too long; exiting');
    process.exit(code || 1);
  }, 25_000);
  watchdog.unref();
  try {
    await app.close();
    await ctx.close();
  } catch (err) {
    app.log.error({ err }, 'error while shutting down');
    code ||= 1;
  }
  process.exit(code);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
// A bug that escapes every handler: log it, finish what we can, and let Docker restart us clean
// (jobs are in Postgres, so nothing is lost).
process.on('unhandledRejection', (err) => {
  captureError(err);
  app.log.error({ err }, 'unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  captureError(err);
  app.log.error({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});

await app.listen({ port: env.PORT, host: env.HOST });
