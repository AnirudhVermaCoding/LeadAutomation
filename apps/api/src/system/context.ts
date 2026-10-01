import { systemClock, type Clock } from '@instantlead/core';
import { createAnthropicProvider, createFakeChannel, type LlmProvider } from '@instantlead/integrations';
import { createFakeLlm } from '../assistant/fake-llm.ts';
import { createDb } from '../db/client.ts';
import type { Env } from '../env.ts';
import { createBoss, createEnqueue } from '../jobs.ts';
import { createAuth } from './auth.ts';
import { createSystemDb } from './db.ts';
import { createSystem } from './index.ts';

/** Composition root. `systemDb` stays in here; the rest of the app only sees `system` functions. */
export function createAppContext(
  env: Env,
  clock: Clock = systemClock,
  overrides: { fetch?: typeof globalThis.fetch; llm?: LlmProvider } = {},
) {
  const app = createDb(env.DATABASE_URL);
  const owner = createSystemDb(env.DATABASE_OWNER_URL);
  const auth = createAuth(owner.db, env);
  const boss = createBoss(env.DATABASE_OWNER_URL);
  const secretsKey = Buffer.from(env.SECRETS_KEY, 'base64');
  const mockMode = env.ALLOW_FAKE_CHANNEL ?? env.NODE_ENV !== 'production';
  if (!env.ANTHROPIC_API_KEY && !mockMode)
    throw new Error(
      'ANTHROPIC_API_KEY is required outside mock mode (set ALLOW_FAKE_CHANNEL=true for a demo)',
    );

  return {
    env,
    clock,
    db: app.db,
    auth,
    boss,
    enqueue: createEnqueue(boss),
    system: createSystem({ systemDb: owner.db, auth, clock }),
    secretsKey,
    fakeChannel: createFakeChannel(),
    allowFakeChannel: mockMode,
    llm:
      overrides.llm ??
      (env.ANTHROPIC_API_KEY ? createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }) : createFakeLlm()),
    llmCostCapUsd: env.LLM_COST_CAP_USD_PER_LEAD,
    fetch: overrides.fetch,
    checkDb: async () => {
      await app.pool.query('select 1');
    },
    /** pg-boss must be started before anything can enqueue; workers only run where ROLE allows. */
    start: async () => {
      boss.on('error', (err) => console.error('pg-boss error', err));
      await boss.start();
    },
    close: async () => {
      await boss.stop({ graceful: true, timeout: 10_000 });
      await Promise.all([app.pool.end(), owner.pool.end()]);
    },
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
