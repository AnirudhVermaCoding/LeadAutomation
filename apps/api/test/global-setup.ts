import { PostgreSqlContainer } from '@testcontainers/postgresql';
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

/** One Postgres container per run; migrations go into a template DB that each test file clones. */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const info: PgInfo = {
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
  };

  const admin = new pg.Client({ connectionString: dbUrl(info, 'postgres') });
  await admin.connect();
  await admin.query(`create database ${TEMPLATE_DB}`);
  await admin.end();
  await migrate(dbUrl(info, TEMPLATE_DB), dbUrl(info, TEMPLATE_DB, 'instantlead_app', APP_DB_PASSWORD));

  project.provide('pg', info);
  return async () => {
    await container.stop();
  };
}
