import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { withTenant } from '../db/client.ts';
import { tenantSecrets, webhookEndpoints, WEBHOOK_EVENTS } from '../db/schema.ts';
import { eraseLead, exportTenantData } from '../privacy.ts';
import { setTenantSecret } from '../secrets.ts';
import type { AppContext } from '../system/context.ts';
import { assertPublicUrl, newWebhookSecret, webhookSecretName } from '../webhooks-out.ts';
import { guard, type Principal } from './auth.ts';

const actor = (p: Principal | null) =>
  p?.kind === 'user' ? ({ type: 'user', id: p.userId } as const) : ({ type: 'system' } as const);
const idParam = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;

/** DPDP rights (erasure, export), the agency breach register, and outbound webhooks. */
export function registerPrivacyRoutes(app: FastifyInstance, ctx: AppContext) {
  const admins = guard(ctx, ['client_admin', 'agency_admin'], { tenant: true });
  const agency = guard(ctx, ['agency_admin'], { tenant: false });
  const tenantOf = (req: FastifyRequest) => req.tenantId as string;

  // Erasure request from a lead: everything goes; the opt-out suppression (a hash) stays.
  app.delete('/v1/leads/:id', { preHandler: admins }, async (req, reply) => {
    const id = idParam(req);
    const erased = await withTenant(ctx.db, tenantOf(req), (tx) =>
      eraseLead(tx, ctx.clock, actor(req.principal), id),
    );
    return erased ? { erased: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.get('/v1/export', { preHandler: admins }, async (req, reply) => {
    const data = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      await audit(tx, ctx.clock, actor(req.principal), { action: 'tenant.exported', entityType: 'tenant' });
      return exportTenantData(tx);
    });
    return reply
      .header(
        'content-disposition',
        `attachment; filename="instantlead-export-${data.exportedAt.slice(0, 10)}.json"`,
      )
      .send(data);
  });

  // ---- Outbound webhooks (client CRMs, Zapier, Make…) ----

  const endpointColumns = {
    id: webhookEndpoints.id,
    url: webhookEndpoints.url,
    events: webhookEndpoints.events,
    active: webhookEndpoints.active,
    lastStatus: webhookEndpoints.lastStatus,
    lastError: webhookEndpoints.lastError,
    lastDeliveredAt: webhookEndpoints.lastDeliveredAt,
    createdAt: webhookEndpoints.createdAt,
  };
  app.get('/v1/webhooks', { preHandler: admins }, (req) =>
    withTenant(ctx.db, tenantOf(req), (tx) =>
      tx.select(endpointColumns).from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt)),
    ),
  );

  const production = ctx.env.NODE_ENV === 'production';
  app.post('/v1/webhooks', { preHandler: admins }, async (req, reply) => {
    const body = z
      .strictObject({
        url: z
          .url({ protocol: production ? /^https$/ : /^https?$/ })
          .max(500)
          .describe('https only in production'),
        events: z
          .array(z.enum(WEBHOOK_EVENTS))
          .min(1)
          .default([...WEBHOOK_EVENTS]),
      })
      .parse(req.body);
    if (!ctx.allowPrivateWebhooks)
      try {
        await assertPublicUrl(body.url);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: err instanceof Error ? err.message : String(err) });
      }
    const secret = newWebhookSecret();
    const tenantId = tenantOf(req);
    const endpoint = await withTenant(ctx.db, tenantId, async (tx) => {
      const [row] = await tx.insert(webhookEndpoints).values(body).returning(endpointColumns);
      await setTenantSecret(tx, ctx.secretsKey, tenantId, webhookSecretName(row!.id), secret);
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'webhook.created',
        entityType: 'webhook_endpoint',
        entityId: row!.id,
      });
      return row!;
    });
    // The signing secret is shown once, like API keys.
    return reply.code(201).send({ ...endpoint, secret });
  });

  app.delete('/v1/webhooks/:id', { preHandler: admins }, async (req, reply) => {
    const id = idParam(req);
    const deleted = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const rows = await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).returning();
      await tx.delete(tenantSecrets).where(eq(tenantSecrets.name, webhookSecretName(id)));
      if (rows.length)
        await audit(tx, ctx.clock, actor(req.principal), {
          action: 'webhook.deleted',
          entityType: 'webhook_endpoint',
          entityId: id,
        });
      return rows.length > 0;
    });
    return deleted ? { deleted: true } : reply.code(404).send({ error: 'not_found' });
  });

  // ---- Agency breach register (DPDP: record, report to the Board, notify users) ----

  app.get('/v1/admin/breaches', { preHandler: agency }, () => ctx.system.listBreaches());

  app.post('/v1/admin/breaches', { preHandler: agency }, async (req, reply) => {
    const b = z
      .strictObject({
        tenantId: z.uuid().nullable().default(null),
        detectedAt: z.iso.datetime({ offset: true }),
        description: z.string().trim().min(10).max(5000),
        affectedCount: z.int().nonnegative().nullable().default(null),
        reportedToBoardAt: z.iso.datetime({ offset: true }).nullable().default(null),
        usersNotifiedAt: z.iso.datetime({ offset: true }).nullable().default(null),
        notes: z.string().max(5000).nullable().default(null),
      })
      .parse(req.body);
    const date = (v: string | null) => (v ? new Date(v) : null);
    const row = await ctx.system.recordBreach({
      ...b,
      detectedAt: new Date(b.detectedAt),
      reportedToBoardAt: date(b.reportedToBoardAt),
      usersNotifiedAt: date(b.usersNotifiedAt),
      recordedBy: req.principal?.kind === 'user' ? req.principal.userId : null,
    });
    return reply.code(201).send(row);
  });
}
