import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { captureError } from './sentry.ts';
import { requestId, serializeError, serializeRequest } from './log-scrub.ts';

// Keys that may carry PII or credentials anywhere we log objects.
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'apiKey',
  '*.apiKey',
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
  /** Behind a reverse proxy (Caddy): take the client IP from X-Forwarded-For (rate limits, logs). */
  trustProxy?: boolean;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app: FastifyInstance = Fastify({
    logger: {
      level: deps.logLevel,
      redact: { paths: REDACT, censor: '[redacted]' },
      // No bound SQL parameters, no tokens in query strings, no customer numbers in error text.
      serializers: { err: serializeError, req: serializeRequest },
    },
    trustProxy: deps.trustProxy ?? false,
    requestIdHeader: false,
    genReqId: (req) => requestId(req.headers['x-request-id']),
  });
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    done();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', message: z.prettifyError(err) });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      captureError(err, { route: _req.routeOptions?.url });
      app.log.error({ err }, 'request failed');
    }
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? undefined : err instanceof Error ? err.message : undefined,
    });
  });

  // Baseline security headers. The public lead form (/f/*) may be iframed by the clinic's site.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Behind Caddy (HTTPS): tell browsers to stay on HTTPS.
    if (deps.trustProxy) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/f/')) {
      // Hosted lead form: no scripts, inline styles only, embeddable anywhere, posts to itself.
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors *",
      );
    } else {
      reply.header('x-frame-options', 'DENY');
      reply.header(
        'content-security-policy',
        "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      );
    }
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
