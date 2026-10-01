import { PRESET_KEYS, validateConfig, type PresetKey } from '@instantlead/config';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit.ts';
import { getActiveConfig, saveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import type { AppContext } from '../system/context.ts';
import { guard, type Principal } from './auth.ts';

const actorOf = (p: Principal | null): Actor =>
  p?.kind === 'user'
    ? { type: 'user', id: p.userId }
    : p
      ? { type: 'api_key', id: p.apiKeyId }
      : { type: 'system' };

/** Set by guard() on every tenant route. */
const tenantOf = (req: FastifyRequest) => {
  if (!req.tenantId) throw new Error('tenant route without guard');
  return req.tenantId;
};

const CreateTenantBody = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes'),
  name: z.string().trim().min(1),
  preset: z.enum(PRESET_KEYS as [PresetKey, ...PresetKey[]]),
  admin: z
    .strictObject({ email: z.email(), name: z.string().trim().min(1), password: z.string().min(12) })
    .optional(),
});

export function registerRoutes(app: FastifyInstance, ctx: AppContext) {
  const tenantUsers = guard(ctx, ['client_staff', 'client_admin', 'agency_admin'], { tenant: true });
  const tenantAdmins = guard(ctx, ['client_admin', 'agency_admin'], { tenant: true });
  const agencyOnly = guard(ctx, ['agency_admin'], { tenant: false });

  app.get(
    '/v1/me',
    { preHandler: guard(ctx, ['client_staff', 'client_admin', 'agency_admin'], { tenant: false }) },
    (req) => ({
      principal: req.principal,
    }),
  );

  app.get('/v1/config', { preHandler: tenantUsers }, async (req, reply) => {
    const active = await withTenant(ctx.db, tenantOf(req), getActiveConfig);
    return active ?? reply.code(404).send({ error: 'not_found' });
  });

  // Same JSON document as GET: this is also the import path.
  app.put('/v1/config', { preHandler: tenantAdmins }, async (req, reply) => {
    const result = validateConfig(req.body);
    if (!result.ok) return reply.code(400).send({ error: 'invalid_config', errors: result.errors });
    const revision = await withTenant(ctx.db, tenantOf(req), (tx) =>
      saveConfig(tx, ctx.clock, actorOf(req.principal), result.config),
    );
    return { revision };
  });

  app.get('/v1/admin/tenants', { preHandler: agencyOnly }, () => ctx.system.listTenants());

  app.post('/v1/admin/tenants', { preHandler: agencyOnly }, async (req, reply) => {
    const body = CreateTenantBody.parse(req.body);
    if (await ctx.system.findTenantBySlug(body.slug))
      return reply.code(409).send({ error: 'slug_taken', message: `Tenant "${body.slug}" already exists` });
    const created = await ctx.system.createTenant(body, actorOf(req.principal));
    return reply.code(201).send(created);
  });
}
