import { sql } from 'drizzle-orm';
import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.ts';

export function createDb(url: string, max = 10) {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
  // A runaway query must not hold a connection (and a job) for ever. Set by SQL on each new connection, not as a
  // startup parameter: connection poolers (Supabase's Supavisor, PgBouncer) may refuse unknown startup parameters.
  // pg runs a client's queries in order, so this one completes before the client's first real query.
  pool.on('connect', (client) => {
    client
      .query('set statement_timeout = 30000')
      .catch((err: Error) => console.error('postgres: could not set statement_timeout', err.message));
  });
  // An idle client erroring (the database restarted) must not crash the process: the pool replaces it.
  pool.on('error', (err) => console.error('postgres pool error (idle client)', err.message));
  return { pool, db: drizzle({ client: pool, schema, casing: 'snake_case' }) };
}

export type Db = ReturnType<typeof createDb>['db'];
export type TenantTx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything queries can run on: the pool or a transaction. */
export type Tx = PgDatabase<NodePgQueryResultHKT, typeof schema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only way to touch tenant data: a transaction whose RLS context is `tenantId`.
 * Anything outside it sees zero tenant rows. Don't nest: use the `tx` you were given.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('withTenant: tenantId must be a uuid');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
