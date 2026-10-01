import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { FakeClock } from '@instantlead/core';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadEnv } from '../src/env.ts';
import { registerHttp } from '../src/http/index.ts';
import { QUEUES, type JobData } from '../src/jobs.ts';
import { createAppContext } from '../src/system/context.ts';
import { runAssistantTurn } from '../src/assistant/agent.ts';
import { notifyAppointmentChange } from '../src/notify.ts';
import { importMetaLead, sendFirstReply } from '../src/workers.ts';
import type { CalendarProvider } from '@instantlead/integrations';
import type { Tx } from '../src/db/client.ts';
import type { LlmProvider } from '@instantlead/integrations';
import { APP_DB_PASSWORD, TEMPLATE_DB, dbUrl } from './global-setup.ts';

export const APP_URL = 'http://localhost:3000';
export const PASSWORD = 'correct-horse-battery';
export const META_APP_SECRET = 'test-meta-app-secret';
export const META_VERIFY_TOKEN = 'test-verify-token';

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
export async function createTestContext(
  opts: {
    fetch?: typeof globalThis.fetch;
    allowFakeChannel?: boolean;
    llm?: LlmProvider;
    calendarFor?: (tx: Tx, tenantId: string) => Promise<CalendarProvider | null>;
  } = {},
) {
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
    META_APP_SECRET,
    META_VERIFY_TOKEN,
    ALLOW_FAKE_CHANNEL: String(opts.allowFakeChannel ?? true),
  });
  const clock = new FakeClock('2026-10-05T04:30:00Z');
  const ctx = createAppContext(env, clock, {
    fetch: opts.fetch,
    llm: opts.llm,
    calendarFor: opts.calendarFor,
  });
  const app = buildApp({ logLevel: 'silent', checkDb: ctx.checkDb });
  await registerHttp(app, ctx);
  await app.ready();
  await ctx.start();

  const owner = new pg.Pool({ connectionString: env.DATABASE_OWNER_URL, max: 2 });

  return {
    ctx,
    app,
    clock,
    /** Owner connection for assertions about the database itself. */
    owner,
    /**
     * Run every queued job once, synchronously, instead of background workers — tests stay
     * deterministic. Returns what each handler returned (or threw).
     */
    async drainJobs() {
      const results: { queue: string; data: unknown; result?: unknown; error?: unknown }[] = [];
      const handlers = {
        [QUEUES.firstReply]: (d: JobData['first-reply']) => sendFirstReply(ctx, d),
        [QUEUES.metaLeadgen]: (d: JobData['meta-leadgen']) => importMetaLead(ctx, d),
        [QUEUES.appointmentNotify]: (d: JobData['appointment-notify']) => notifyAppointmentChange(ctx, d),
      } as Record<string, (d: never) => Promise<unknown>>;
      for (const [queue, handler] of Object.entries(handlers)) {
        for (;;) {
          const jobs = await ctx.boss.fetch<never>(queue, { batchSize: 50 });
          if (!jobs.length) break;
          for (const job of jobs) {
            try {
              results.push({ queue, data: job.data, result: await handler(job.data) });
              await ctx.boss.complete(queue, job.id);
            } catch (error) {
              results.push({ queue, data: job.data, error });
              await ctx.boss.fail(queue, job.id, { message: String(error) });
            }
          }
        }
      }
      return results;
    },
    /** Run queued assistant turns now (ignoring the 3 s debounce). */
    async drainAssistant() {
      const results: unknown[] = [];
      for (;;) {
        const jobs = await ctx.boss.fetch<JobData['assistant-turn']>(QUEUES.assistantTurn, {
          batchSize: 10,
          ignoreStartAfter: true,
        });
        if (!jobs.length) return results;
        for (const job of jobs) {
          results.push(await runAssistantTurn(ctx, job.data.tenantId, job.data.leadId));
          await ctx.boss.complete(QUEUES.assistantTurn, job.id);
        }
      }
    },
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
