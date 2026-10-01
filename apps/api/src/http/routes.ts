import {
  PRESET_KEYS,
  TEMPLATE_KEYS,
  TEMPLATE_LANGUAGES,
  validateConfig,
  type PresetKey,
} from '@instantlead/config';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, type Actor } from '../audit.ts';
import { getActiveConfig, saveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import { conversations, leads, messages, templates } from '../db/schema.ts';
import { getTenantSecret, setTenantSecret } from '../secrets.ts';
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

  // ---- Integrations: credentials are write-only; reads report only what is connected ----

  app.get('/v1/integrations', { preHandler: tenantUsers }, async (req) => {
    const tenantId = tenantOf(req);
    const routing = await ctx.system.getTenantRouting(tenantId);
    const has = (name: string) =>
      withTenant(
        ctx.db,
        tenantId,
        async (tx) => (await getTenantSecret(tx, ctx.secretsKey, tenantId, name)) !== null,
      );
    const whatsappConnected = Boolean(routing?.waPhoneNumberId) && (await has('whatsapp_access_token'));
    return {
      whatsapp: { connected: whatsappConnected, phone_number_id: routing?.waPhoneNumberId ?? null },
      lead_ads: {
        connected: Boolean(routing?.metaPageId) && (await has('meta_page_access_token')),
        page_id: routing?.metaPageId ?? null,
      },
      channel: whatsappConnected ? 'meta' : ctx.allowFakeChannel ? 'fake' : 'none',
      form_url: routing ? `${ctx.env.APP_URL}/f/${routing.formKey}` : null,
    };
  });

  const ConnectBody = z.strictObject({
    id: z.string().regex(/^\d{5,30}$/, 'numeric Meta id'),
    access_token: z.string().min(20),
  });
  const connect = (kind: 'whatsapp' | 'lead_ads') => async (req: FastifyRequest) => {
    const body = ConnectBody.parse(req.body);
    const tenantId = tenantOf(req);
    await ctx.system.setTenantRouting(
      tenantId,
      kind === 'whatsapp' ? { waPhoneNumberId: body.id } : { metaPageId: body.id },
    );
    await withTenant(ctx.db, tenantId, async (tx) => {
      const secret = kind === 'whatsapp' ? 'whatsapp_access_token' : 'meta_page_access_token';
      await setTenantSecret(tx, ctx.secretsKey, tenantId, secret, body.access_token);
      await audit(tx, ctx.clock, actorOf(req.principal), {
        action: `integration.${kind}.connected`,
        entityType: 'integration',
        entityId: kind,
      });
    });
    return { connected: true };
  };
  app.put('/v1/integrations/whatsapp', { preHandler: tenantAdmins }, connect('whatsapp'));
  app.put('/v1/integrations/lead-ads', { preHandler: tenantAdmins }, connect('lead_ads'));

  // ---- Templates: approval status per tenant (the client submits them; see TEMPLATES-TO-SUBMIT.md) ----

  app.get('/v1/templates', { preHandler: tenantUsers }, (req) =>
    withTenant(ctx.db, tenantOf(req), (tx) =>
      tx.select().from(templates).orderBy(asc(templates.key), asc(templates.language)),
    ),
  );

  const TemplateParams = z.object({ key: z.enum(TEMPLATE_KEYS), language: z.enum(TEMPLATE_LANGUAGES) });
  const TemplateBody = z.strictObject({
    status: z.enum(['draft', 'submitted', 'approved', 'rejected']).optional(),
    provider_name: z
      .string()
      .regex(/^[a-z0-9_]{1,512}$/)
      .optional(),
  });
  app.put('/v1/templates/:key/:language', { preHandler: tenantAdmins }, async (req, reply) => {
    const { key, language } = TemplateParams.parse(req.params);
    const body = TemplateBody.parse(req.body);
    const updated = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const rows = await tx
        .update(templates)
        .set({ status: body.status, providerName: body.provider_name })
        .where(and(eq(templates.key, key), eq(templates.language, language)))
        .returning();
      await audit(tx, ctx.clock, actorOf(req.principal), {
        action: 'template.updated',
        entityType: 'template',
        entityId: `${key}:${language}`,
        details: { status: body.status, providerName: body.provider_name },
      });
      return rows[0];
    });
    return updated ?? reply.code(404).send({ error: 'not_found' });
  });

  // ---- Leads (minimal reads; the inbox UI arrives in M6) ----

  app.get('/v1/leads', { preHandler: tenantUsers }, (req) =>
    withTenant(ctx.db, tenantOf(req), (tx) =>
      tx.select().from(leads).orderBy(desc(leads.receivedAt)).limit(200),
    ),
  );

  app.get('/v1/leads/:id/messages', { preHandler: tenantUsers }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const result = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const [lead] = await tx.select().from(leads).where(eq(leads.id, id));
      if (!lead) return null;
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.leadId, id));
      const thread = await tx
        .select()
        .from(messages)
        .where(eq(messages.leadId, id))
        .orderBy(asc(messages.occurredAt));
      return { lead, conversation: conversation ?? null, messages: thread };
    });
    return result ?? reply.code(404).send({ error: 'not_found' });
  });
}
