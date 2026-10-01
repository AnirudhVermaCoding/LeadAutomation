import { z } from 'zod';

const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Public base URL of the app (auth cookies, trusted origin). */
    APP_URL: z.url().default('http://localhost:3000'),
    /** App role connection: RLS applies. */
    DATABASE_URL: pgUrl,
    /** Owner connection: migrations and pre-tenant lookups only. */
    DATABASE_OWNER_URL: pgUrl,
    BETTER_AUTH_SECRET: z.string().min(32, 'use at least 32 random characters'),
    SECRETS_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded'),
    AGENCY_ADMIN_EMAIL: z.email().optional(),
    AGENCY_ADMIN_PASSWORD: z.string().min(12, 'use at least 12 characters').optional(),
    SEED_PASSWORD: z.string().min(12, 'use at least 12 characters').optional(),
    /** api = HTTP only, worker = jobs only, all = both (single small VPS). */
    ROLE: z.enum(['all', 'api', 'worker']).default('all'),
    /** Tenants without WhatsApp credentials use the fake channel. Defaults to on outside production. */
    ALLOW_FAKE_CHANNEL: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    /** Meta app (one app receives webhooks for every client number/page). */
    META_APP_SECRET: z.string().min(1).optional(),
    META_VERIFY_TOKEN: z.string().min(1).optional(),
    /** Claude API key for the assistant. Without it, mock mode uses a rule-based fake assistant. */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /** Per-lead LLM spend ceiling (USD); beyond it the conversation is handed to staff. */
    LLM_COST_CAP_USD_PER_LEAD: z.coerce.number().positive().default(0.5),
    /** Resend, for staff alerts and reports by email (mock mode logs instead). */
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(3).optional(),
    /** Google OAuth client for the optional one-way Google Calendar sync. */
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    // .env.example ships dev-only secrets; never let them reach production.
    if (env.NODE_ENV !== 'production') return;
    const devOnly = {
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      SECRETS_KEY: Buffer.from(env.SECRETS_KEY, 'base64').toString('latin1'),
    };
    for (const [name, value] of Object.entries(devOnly))
      if (value.startsWith('dev-only'))
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'dev-only value from .env.example; generate a real secret',
        });
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment (see .env.example):\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
