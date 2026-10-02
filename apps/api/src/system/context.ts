import { OffsetClock, systemClock, type Clock } from '@instantlead/core';
import {
  ChannelError,
  createFakeChannel,
  createFakeEmail,
  createGoogleCalendar,
  createResendEmail,
  type CalendarProvider,
  type EmailProvider,
  type GoogleOAuthClient,
  type LlmProvider,
} from '@instantlead/integrations';
import { getTenantSecret, type SecretsKey } from '../secrets.ts';
import type { Tx } from '../db/client.ts';
import { createFakeLlm } from '../assistant/fake-llm.ts';
import { createLlmRouter } from '../llm-router.ts';
import { createDb } from '../db/client.ts';
import type { Env } from '../env.ts';
import { createBoss, createEnqueue } from '../jobs.ts';
import { createAuth } from './auth.ts';
import { createSystemDb } from './db.ts';
import { createSystem } from './index.ts';

/** Composition root. `systemDb` stays in here; the rest of the app only sees `system` functions. */
export function createAppContext(
  env: Env,
  clockOverride?: Clock,
  overrides: {
    fetch?: typeof globalThis.fetch;
    /** Tests: one model for every task (e.g. a scripted fake). */
    llm?: LlmProvider;
    /** Tests: these model instances replace key-based providers (routing still applies). */
    llmProviders?: LlmProvider[];
    calendarFor?: (tx: Tx, tenantId: string) => Promise<CalendarProvider | null>;
  } = {},
) {
  const app = createDb(env.DATABASE_URL);
  const owner = createSystemDb(env.DATABASE_OWNER_URL);
  const auth = createAuth(owner.db, env);
  const boss = createBoss(env.DATABASE_OWNER_URL);
  const secretsKey: SecretsKey = env.SECRETS_KEY_PREVIOUS
    ? [Buffer.from(env.SECRETS_KEY, 'base64'), Buffer.from(env.SECRETS_KEY_PREVIOUS, 'base64')]
    : Buffer.from(env.SECRETS_KEY, 'base64');
  const mockMode = env.ALLOW_FAKE_CHANNEL ?? env.NODE_ENV !== 'production';
  // Mock mode runs on a clock the demo can fast-forward; production on real time.
  const clock: Clock = clockOverride ?? (mockMode ? new OffsetClock() : systemClock);
  const llmKeys = {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    gemini: env.GEMINI_API_KEY,
    xai: env.XAI_API_KEY,
  };
  if (!Object.values(llmKeys).some(Boolean) && !mockMode)
    throw new Error(
      'An AI provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY or XAI_API_KEY) is required outside mock mode (set ALLOW_FAKE_CHANNEL=true for a demo)',
    );

  // Email: Resend when configured; mock mode records in memory; otherwise sends fail loudly.
  const email: EmailProvider =
    env.RESEND_API_KEY && env.EMAIL_FROM
      ? createResendEmail({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, fetch: overrides.fetch })
      : mockMode
        ? createFakeEmail()
        : {
            provider: 'fake',
            send: () =>
              Promise.reject(
                new ChannelError('Email is not configured (RESEND_API_KEY, EMAIL_FROM)', {
                  retryable: false,
                }),
              ),
          };
  const googleOAuth: GoogleOAuthClient | null =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          redirectUri: `${env.APP_URL}/v1/integrations/google/callback`,
          fetch: overrides.fetch,
        }
      : null;

  return {
    env,
    clock,
    db: app.db,
    auth,
    boss,
    enqueue: createEnqueue(boss),
    system: createSystem({ systemDb: owner.db, auth, clock }),
    secretsKey,
    hashKey: Buffer.from(env.HASH_KEY ?? env.SECRETS_KEY, 'base64'),
    fakeChannel: createFakeChannel(),
    allowFakeChannel: mockMode,
    /** Outside production, webhooks may target localhost / private hosts (testing receivers). */
    allowPrivateWebhooks: env.NODE_ENV !== 'production',
    /** Picks the model(s) for each AI task per tenant: routing, allowed providers, failover order. */
    router: createLlmRouter({
      keys: llmKeys,
      fake: overrides.llm ?? createFakeLlm(),
      providers: overrides.llm ? [overrides.llm] : overrides.llmProviders,
    }),
    llmCostCapUsd: env.LLM_COST_CAP_USD_PER_LEAD,
    email,
    googleOAuth,
    /** The tenant's Google Calendar, if they connected one. */
    calendarFor:
      overrides.calendarFor ??
      (async (tx: Tx, tenantId: string): Promise<CalendarProvider | null> => {
        if (!googleOAuth) return null;
        const refreshToken = await getTenantSecret(tx, secretsKey, tenantId, 'google_refresh_token');
        return refreshToken ? createGoogleCalendar({ client: googleOAuth, refreshToken }) : null;
      }),
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
