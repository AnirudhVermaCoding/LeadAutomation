import Fastify from 'fastify';
import { z } from 'zod';

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

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', message: z.prettifyError(err) });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error({ err }, 'request failed');
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? undefined : err instanceof Error ? err.message : undefined,
    });
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
