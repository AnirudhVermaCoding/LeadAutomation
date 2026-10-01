import Fastify from 'fastify';

// Keys that may carry PII or credentials anywhere we log objects.
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'phone',
  '*.phone',
  'phone_e164',
  '*.phone_e164',
  'email',
  '*.email',
  'first_name',
  '*.first_name',
];

export interface AppDeps {
  logLevel: string;
  checkDb: () => Promise<void>;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: { level: deps.logLevel, redact: { paths: REDACT, censor: '[redacted]' } },
  });

  app.get('/healthz', () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.checkDb();
      return { ok: true };
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ ok: false });
    }
  });

  return app;
}
