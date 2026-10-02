import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate.ts';

export interface PgInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    pg: PgInfo;
  }
}

export const TEMPLATE_DB = 'il_template';
export const APP_DB_PASSWORD = 'app_test_pw';
export const dbUrl = (info: PgInfo, db: string, user = info.user, password = info.password) =>
  `postgres://${user}:${password}@${info.host}:${info.port}/${db}`;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/**
 * One throwaway Postgres 16 per test run (real binaries via embedded-postgres: no Docker,
 * no admin rights). Migrations go into a template DB that each test file clones.
 */
export default async function setup(project: TestProject) {
  const info: PgInfo = { host: '127.0.0.1', port: await freePort(), user: 'postgres', password: 'postgres' };
  const server = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), 'instantlead-pg-')),
    port: info.port,
    user: info.user,
    password: info.password,
    persistent: false,
    // Same as production: UTF-8 (Windows would otherwise default to WIN1252 and reject Hindi text).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Each test file opens several pools; the default 100 slots flaked ("remaining connection slots").
    postgresFlags: ['-c', 'max_connections=500'],
    onLog: () => undefined,
  });
  await server.initialise();
  await server.start();

  const admin = new pg.Client({ connectionString: dbUrl(info, 'postgres') });
  await admin.connect();
  await admin.query(`create database ${TEMPLATE_DB}`);
  await admin.end();
  await migrate(dbUrl(info, TEMPLATE_DB), dbUrl(info, TEMPLATE_DB, 'instantlead_app', APP_DB_PASSWORD));

  project.provide('pg', info);
  return async () => {
    await server.stop();
  };
}
