import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../system/context.ts';
import { decorateRequests, registerAuthRoutes } from './auth.ts';
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
}
