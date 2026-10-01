import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../system/context.ts';
import { decorateRequests, registerAuthRoutes } from './auth.ts';
import { registerBookingRoutes } from './booking.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerIntakeRoutes } from './intake.ts';
import { registerRoutes } from './routes.ts';
import { registerWebhookRoutes } from './webhooks.ts';

/** Everything the HTTP app serves. Used by main.ts and the tests. */
export async function registerHttp(app: FastifyInstance, ctx: AppContext) {
  decorateRequests(app);
  // Opt-in per route (public form, intake API); webhooks from Meta are never throttled.
  await app.register(rateLimit, { global: false });
  registerAuthRoutes(app, ctx);
  registerRoutes(app, ctx);
  registerIntakeRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerBookingRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
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
