import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../system/context.ts';
import { decorateRequests, registerAuthRoutes } from './auth.ts';
import { registerBookingRoutes } from './booking.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerGoogleRoutes } from './google.ts';
import { registerIntakeRoutes } from './intake.ts';
import { registerJourneyRoutes } from './journey.ts';
import { registerPrivacyRoutes } from './privacy.ts';
import { registerRoutes } from './routes.ts';
import { registerWebhookRoutes } from './webhooks.ts';

/** Everything the HTTP app serves. Used by main.ts and the tests. */
export async function registerHttp(app: FastifyInstance, ctx: AppContext) {
  decorateRequests(app);
  const production = ctx.env.NODE_ENV === 'production';
  // A generous per-IP ceiling on everything (credential stuffing, scrapers); routes with their own
  // limits (public form, intake API) set stricter ones. Meta's webhooks and health checks are never
  // throttled; locally (dev, tests, load test) loopback is exempt.
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: (req) =>
      req.url.startsWith('/webhooks/meta') ||
      req.url === '/healthz' ||
      req.url === '/readyz' ||
      (!production && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)),
  });

  // CSRF: a browser session (cookie) may only change things from our own pages. Browsers always send
  // Origin on cross-site POSTs; API keys and webhooks carry no cookie and are unaffected. No Origin and no
  // Sec-Fetch-Site (curl, our scripts) is not a browser, so it passes.
  const ownOrigin = new URL(ctx.env.APP_URL).origin;
  app.addHook('onRequest', (req, reply, done) => {
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!unsafe || !req.url.startsWith('/v1/') || !req.headers.cookie || req.headers.authorization)
      return done();
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    const devOrigin = !production && typeof origin === 'string' && /^http:\/\/localhost:\d+$/.test(origin);
    const bad =
      (typeof origin === 'string' && origin !== ownOrigin && !devOrigin) ||
      (typeof site === 'string' && !['same-origin', 'none'].includes(site) && !devOrigin);
    if (bad) return void reply.code(403).send({ error: 'cross_site_request_blocked' });
    done();
  });
  registerAuthRoutes(app, ctx);
  registerRoutes(app, ctx);
  registerIntakeRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerBookingRoutes(app, ctx);
  registerGoogleRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerJourneyRoutes(app, ctx);
  registerPrivacyRoutes(app, ctx);
  await serveDashboard(app);
}

const DASHBOARD_DIST = fileURLToPath(new URL('../../../dashboard/dist', import.meta.url));

/** The built dashboard, same origin as the API (cookie auth, no CORS). Absent in API-only dev. */
async function serveDashboard(app: FastifyInstance) {
  if (!existsSync(DASHBOARD_DIST)) return;
  await app.register(fastifyStatic, { root: DASHBOARD_DIST });
  // Client-side routes (/inbox, /settings…) get index.html; unknown API paths stay 404 JSON.
  app.setNotFoundHandler((req, reply) => {
    const api = /^\/(v1|api|webhooks|f)(\/|$)/.test(req.url);
    if (req.method === 'GET' && !api) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
}
