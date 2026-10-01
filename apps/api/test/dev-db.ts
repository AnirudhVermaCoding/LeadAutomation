/**
 * Local Postgres 16 without Docker (`pnpm db:local`): real binaries via embedded-postgres,
 * data kept in .data/pg. Matches the compose `db` service (user instantlead, db instantlead, :5432).
 * Stop with Ctrl+C.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = fileURLToPath(new URL('../../../.data/pg', import.meta.url));
const fresh = !existsSync(dataDir);
const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: 5432,
  user: 'instantlead',
  password: process.env.POSTGRES_PASSWORD ?? 'instantlead_dev',
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

if (fresh) await server.initialise();
await server.start();
if (fresh) await server.createDatabase('instantlead');
console.log(`Postgres 16 on localhost:5432 (data: ${dataDir}). Ctrl+C to stop.`);

const stop = () => void server.stop().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
setInterval(() => undefined, 1 << 30); // keep the process alive
