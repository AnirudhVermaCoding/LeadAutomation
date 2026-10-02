import { randomUUID } from 'node:crypto';

/**
 * Logs must never carry customer data. Database errors are the usual leak: Drizzle puts the bound
 * parameters in the message, Postgres puts the offending value in the detail ("Key (phone)=(+91…)"),
 * and URLs carry tokens (Meta verify token, Google OAuth code) in the query string.
 */
export function scrubText(text: string): string {
  return text
    .replace(/\nparams:[^\n]*/g, '\nparams: [redacted]') // Drizzle: "Failed query: …\nparams: a,b,c"
    .replace(/\(([^()]*)\)=\(([^()]*)\)/g, '($1)=([redacted])') // Postgres: Key (col)=(value)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+\d{10,15}(?!\d)/g, '[number]')
    .replace(/(?<![\d-])(?:91[\s-]?)?[6-9]\d{9}(?!\d)/g, '[number]');
}

/** pino `err` serializer: type, scrubbed message and stack, the pg error code, never the bound parameters. */
export function serializeError(err: unknown): {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
} {
  if (!(err instanceof Error)) return { type: 'NonError', message: scrubText(String(err)), stack: '' };
  const e = err as Error & { code?: string; cause?: unknown };
  const cause = e.cause instanceof Error ? (e.cause as Error & { code?: string }) : undefined;
  return {
    type: e.name,
    message: scrubText(e.message),
    code: e.code ?? cause?.code,
    ...(cause ? { cause: { type: cause.name, message: scrubText(cause.message), code: cause.code } } : {}),
    stack: e.stack ? scrubText(e.stack) : '',
  };
}

/** Paths whose query string is a credential or a one-time code. */
const SENSITIVE_QUERY = /^\/(webhooks|v1\/integrations\/google\/callback|api\/auth)/;

/** pino `req` serializer: no query string on sensitive paths. */
export function serializeRequest(req: {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  id?: string;
}) {
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? '';
  return {
    method: req.method,
    url: SENSITIVE_QUERY.test(path) ? path : url,
    host: req.host,
    remoteAddress: req.ip,
  };
}

/** Honour a sane incoming x-request-id (a proxy's or the caller's), else make one. */
export function requestId(header: string | string[] | undefined): string {
  const v = Array.isArray(header) ? header[0] : header;
  return v && /^[A-Za-z0-9._-]{8,64}$/.test(v) ? v : randomUUID();
}
