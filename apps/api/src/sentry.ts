import { scrubText } from './log-scrub.ts';

type Capture = (err: unknown, context?: Record<string, string | undefined>) => void;
let capture: Capture = () => undefined;

/** Report an unexpected error to the error tracker (a no-op until `initErrorTracking` ran with a DSN). */
export const captureError: Capture = (err, context) => capture(err, context);

/**
 * Optional Sentry (or self-hosted GlitchTip: same SDK and DSN format). Off unless SENTRY_DSN is set.
 * No default PII, no request bodies, no breadcrumbs, and every message and stack frame is scrubbed of
 * numbers, emails and SQL parameters before it leaves the process.
 */
export async function initErrorTracking(env: { SENTRY_DSN?: string | undefined; NODE_ENV: string }) {
  if (!env.SENTRY_DSN) return false;
  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    maxBreadcrumbs: 0,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.contexts?.device;
      if (event.message) event.message = scrubText(event.message);
      for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrubText(ex.value);
      return event;
    },
  });
  capture = (err, context) => Sentry.captureException(err, context ? { tags: context } : undefined);
  return true;
}
