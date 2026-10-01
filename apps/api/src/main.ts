import pg from 'pg';
import { buildApp } from './app.ts';
import { loadEnv } from './env.ts';

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

const app = buildApp({
  logLevel: env.LOG_LEVEL,
  checkDb: async () => {
    await pool.query('select 1');
  },
});

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
