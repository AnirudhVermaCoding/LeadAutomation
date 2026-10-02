import { z } from 'zod';

const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    /** true when a reverse proxy (Caddy) sits in front; see docs/OPERATIONS.md. */
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
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
    /**
     * Keys the opt-out phone hashes; defaults to SECRETS_KEY. Before the first SECRETS_KEY
     * rotation set it to the current SECRETS_KEY and never change it (docs/OPERATIONS.md).
     */
    HASH_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded')
      .optional(),
    /** Only during a key rotation: the old key, still accepted for decryption. */
    SECRETS_KEY_PREVIOUS: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded')
      .optional(),
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
    /** Optional extra AI providers (OpenAI-compatible APIs). A provider without a key is disabled. */
    OPENAI_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),
    XAI_API_KEY: z.string().min(1).optional(),
    /** Per-lead LLM spend ceiling (USD); beyond it the conversation is handed to staff. */
    LLM_COST_CAP_USD_PER_LEAD: z.coerce.number().positive().default(0.5),
    /** Resend, for staff alerts and reports by email (mock mode logs instead). */
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(3).optional(),
    /** Google OAuth client for the optional one-way Google Calendar sync. */
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    /** Where operational alerts go (failed sends, silent webhooks, LLM errors, dead jobs). */
    ALERT_EMAIL: z.email().optional(),
    /** Error tracking (Sentry, or self-hosted GlitchTip). Off when unset. */
    SENTRY_DSN: z.url().optional(),
    /** Pinged after every monitor run (every 5 minutes): an uptime service alerts you when the pings stop. */
    HEARTBEAT_URL: z.url().optional(),
    /** Agency alerts on WhatsApp, from the agency's own WABA (approved template il_agency_alert). All three, or none. */
    ALERT_WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
    ALERT_WHATSAPP_TOKEN: z.string().min(1).optional(),
    ALERT_WHATSAPP_TO: z
      .string()
      .regex(/^\+[1-9]\d{9,14}$/)
      .optional(),
  })
  .superRefine((env, ctx) => {
    // .env.example ships dev-only secrets; never let them reach production.
    if (env.NODE_ENV !== 'production') return;
    const devOnly = {
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      SECRETS_KEY: Buffer.from(env.SECRETS_KEY, 'base64').toString('latin1'),
    };
    // The database passwords from .env.example / docker-compose defaults.
    for (const name of ['DATABASE_URL', 'DATABASE_OWNER_URL'] as const)
      if (/instantlead_dev|app_dev_pw/.test(env[name]))
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message:
            'uses the dev database password from .env.example; set POSTGRES_PASSWORD / APP_DB_PASSWORD to real secrets',
        });
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
