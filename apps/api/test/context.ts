import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { FakeClock } from '@instantlead/core';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';
import { decorateRequests, registerAuthRoutes } from '../src/http/auth.ts';
import { registerRoutes } from '../src/http/routes.ts';
import { createAppContext } from '../src/system/context.ts';
import { APP_DB_PASSWORD, TEMPLATE_DB, dbUrl } from './global-setup.ts';

export const APP_URL = 'http://localhost:3000';
export const PASSWORD = 'correct-horse-battery';

/** Clone the migrated template DB (retrying while a sibling test file is cloning it). */
async function cloneTemplate(name: string) {
  const info = inject('pg');
  const admin = new pg.Client({ connectionString: dbUrl(info, 'postgres') });
  await admin.connect();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.query(`create database ${name} template ${TEMPLATE_DB}`);
        return;
      } catch (err) {
        if (attempt > 20 || !String(err).includes('being accessed by other users')) throw err;
        await sleep(100 + Math.random() * 200);
      }
    }
  } finally {
    await admin.end();
  }
}

/** A fresh database + fully wired app for one test file. */
export async function createTestContext() {
  const info = inject('pg');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  await cloneTemplate(name);

  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_URL,
    DATABASE_URL: dbUrl(info, name, 'instantlead_app', APP_DB_PASSWORD),
    DATABASE_OWNER_URL: dbUrl(info, name),
    BETTER_AUTH_SECRET: 'test-only-secret-'.padEnd(48, 'x'),
    SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
  const clock = new FakeClock('2026-10-05T04:30:00Z');
  const ctx = createAppContext(env, clock);
  const app = buildApp({ logLevel: 'silent', checkDb: ctx.checkDb });
  decorateRequests(app);
  registerAuthRoutes(app, ctx);
  registerRoutes(app, ctx);
  await app.ready();

  const owner = new pg.Pool({ connectionString: env.DATABASE_OWNER_URL, max: 2 });

  return {
    ctx,
    app,
    clock,
    /** Owner connection for assertions about the database itself. */
    owner,
    /** Signs in through the real Better Auth endpoint; returns the Cookie header. */
    async signIn(email: string, password = PASSWORD) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: APP_URL },
        payload: { email, password },
      });
      if (res.statusCode !== 200) throw new Error(`sign-in failed (${res.statusCode}): ${res.body}`);
      const cookies = res.headers['set-cookie'];
      return [cookies ?? []]
        .flat()
        .map((c) => c.split(';')[0])
        .join('; ');
    },
    async close() {
      await app.close();
      await ctx.close();
      await owner.end();
    },
  };
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;
