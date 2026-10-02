import { randomUUID } from 'node:crypto';
import { verifyWhatsAppNumber } from '@instantlead/integrations';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { upcomingAppointments } from '../booking.ts';
import { getActiveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import {
  answers,
  apiKeys,
  availabilityRules,
  conversations,
  leads,
  messages,
  templates,
  tenantConfigs,
} from '../db/schema.ts';
import { optIn, optOut, transitionLead } from '../leads.ts';
import { integrationHealth, runMonitor } from '../monitoring.ts';
import { sendToLead } from '../outbound.ts';
import { computeReport, listReports, renderReportEmail } from '../reports.ts';
import { getTenantSecret } from '../secrets.ts';
import type { AppContext } from '../system/context.ts';
import { guard, type Principal } from './auth.ts';

const actor = (p: Principal | null) =>
  p?.kind === 'user' ? ({ type: 'user', id: p.userId } as const) : ({ type: 'system' } as const);

/** Templates a clinic needs approved before going live. */
const GO_LIVE_TEMPLATES = [
  'first_reply',
  'booking_confirmed',
  'booking_pending',
  'reminder_24h',
  'reminder_2h',
  'cancellation',
  'appointment_change',
  // To staff: without these approved, alerts to the clinic's WhatsApp never arrive.
  'staff_new_booking',
  'staff_handover',
  'staff_update',
];

export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  const staff = guard(ctx, ['client_staff', 'client_admin', 'agency_admin'], { tenant: true });
  const admins = guard(ctx, ['client_admin', 'agency_admin'], { tenant: true });
  const agency = guard(ctx, ['agency_admin'], { tenant: false });
  const tenantOf = (req: FastifyRequest) => req.tenantId as string;
  const leadParam = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;

  // Inbox: one lead with everything the conversation view shows.
  app.get('/v1/leads/:id', { preHandler: staff }, async (req, reply) => {
    const id = leadParam(req);
    const result = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const [lead] = await tx.select().from(leads).where(eq(leads.id, id));
      if (!lead) return null;
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.leadId, id));
      return {
        lead,
        conversation: conversation ?? null,
        answers: await tx
          .select({ key: answers.key, value: answers.value })
          .from(answers)
          .where(eq(answers.leadId, id)),
        appointment: (await upcomingAppointments(tx, id, ctx.clock.now()))[0] ?? null,
        appointments: await upcomingAppointments(tx, id, ctx.clock.now()),
        messages: await tx
          .select()
          .from(messages)
          .where(eq(messages.leadId, id))
          .orderBy(asc(messages.occurredAt), asc(messages.createdAt)),
      };
    });
    return result ?? reply.code(404).send({ error: 'not_found' });
  });

  // Human takeover pauses the AI for this lead until resumed.
  for (const [path, type] of [
    ['takeover', 'HUMAN_TAKEOVER'],
    ['resume', 'HUMAN_RESUME'],
  ] as const) {
    app.post(`/v1/leads/:id/${path}`, { preHandler: staff }, async (req) => {
      const id = leadParam(req);
      return withTenant(ctx.db, tenantOf(req), async (tx) => {
        const status = await transitionLead(tx, id, { type });
        await audit(tx, ctx.clock, actor(req.principal), {
          action: `lead.${path}`,
          entityType: 'lead',
          entityId: id,
        });
        return status;
      });
    });
  }

  // The junk filter got it wrong: a real enquiry after all. Clears the tag and turns the AI back on.
  app.post('/v1/leads/:id/real-lead', { preHandler: staff }, async (req, reply) => {
    const id = leadParam(req);
    const status = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const [lead] = await tx.update(leads).set({ notALead: null }).where(eq(leads.id, id)).returning();
      if (!lead) return null;
      if (lead.state === 'disqualified') await transitionLead(tx, id, { type: 'REQUALIFY' });
      const s = await transitionLead(tx, id, { type: 'HUMAN_RESUME' });
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'lead.marked_real',
        entityType: 'lead',
        entityId: id,
      });
      return s;
    });
    return status ?? reply.code(404).send({ error: 'not_found' });
  });

  // The customer told staff (a call, in person) to stop messaging them, or asked to be messaged again.
  // Opting back in needs a note of how they asked: it is kept as the consent evidence.
  app.post('/v1/leads/:id/opt-out', { preHandler: staff }, async (req, reply) => {
    const id = leadParam(req);
    const done = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const [lead] = await tx.select().from(leads).where(eq(leads.id, id));
      if (!lead) return null;
      await optOut(tx, ctx, tenantOf(req), lead, 'manual');
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'lead.opted_out_by_staff',
        entityType: 'lead',
        entityId: id,
      });
      return true;
    });
    return done ? { opted_out: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.post('/v1/leads/:id/opt-in', { preHandler: admins }, async (req, reply) => {
    const id = leadParam(req);
    const { note } = z.strictObject({ note: z.string().trim().min(5).max(300) }).parse(req.body);
    const done = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const [lead] = await tx.select().from(leads).where(eq(leads.id, id));
      if (!lead) return 'missing' as const;
      if (lead.state !== 'opted_out') return 'not_opted_out' as const;
      await optIn(tx, ctx, tenantOf(req), lead, {
        source: 'staff_recorded',
        noticeText: 'Staff recorded that the customer asked to receive messages again.',
        evidence: { note, by: req.principal?.kind === 'user' ? req.principal.userId : null },
      });
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'lead.opted_in_by_staff',
        entityType: 'lead',
        entityId: id,
      });
      return 'ok' as const;
    });
    if (done === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (done === 'not_opted_out') return reply.code(409).send({ error: 'not_opted_out' });
    return { opted_in: true };
  });

  // Staff typing in the inbox: free-form, so only inside the 24 h window.
  app.post('/v1/leads/:id/messages', { preHandler: staff }, async (req, reply) => {
    const id = leadParam(req);
    const { text } = z.strictObject({ text: z.string().trim().min(1).max(4096) }).parse(req.body);
    const result = await sendToLead(ctx, tenantOf(req), {
      leadId: id,
      idempotencyKey: `staff:${randomUUID()}`,
      freeForm: { kind: 'text', body: text },
    });
    if (result.status !== 'sent')
      return reply.code(409).send({ error: result.status, message: result.reason });
    await withTenant(ctx.db, tenantOf(req), (tx) =>
      audit(tx, ctx.clock, actor(req.principal), {
        action: 'message.sent_by_staff',
        entityType: 'lead',
        entityId: id,
      }),
    );
    return result;
  });

  // Settings: what's left before this clinic can go live.
  app.get('/v1/onboarding', { preHandler: staff }, async (req) => {
    const tenantId = tenantOf(req);
    const routing = await ctx.system.getTenantRouting(tenantId);
    return withTenant(ctx.db, tenantId, async (tx) => {
      const active = await getActiveConfig(tx);
      const config = active?.config;
      const [revisions] = await tx.select({ n: count() }).from(tenantConfigs);
      const [rules] = await tx.select({ n: count() }).from(availabilityRules);
      const approved = await tx
        .select({ key: templates.key })
        .from(templates)
        .where(and(eq(templates.status, 'approved'), inArray(templates.key, GO_LIVE_TEMPLATES)));
      const [realSend] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.provider, 'meta'), inArray(messages.status, ['sent', 'delivered', 'read'])))
        .limit(1);
      const token = await getTenantSecret(tx, ctx.secretsKey, tenantId, 'whatsapp_access_token');
      const approvedKeys = new Set(approved.map((a) => a.key));
      const steps = [
        { key: 'config', label: 'Business details reviewed and saved', done: (revisions?.n ?? 0) > 1 },
        {
          key: 'knowledge',
          label: 'Services, prices and FAQs filled in (no SAMPLE text left)',
          done: !!config && !config.qualification.knowledge.some((k) => k.content.includes('SAMPLE')),
        },
        { key: 'hours', label: 'Bookable hours set', done: (rules?.n ?? 0) > 0 },
        {
          key: 'staff',
          label: 'Staff alert number or email set',
          done: !!config && !config.booking.staff_notify.to.includes('0000000000'),
        },
        {
          key: 'review',
          label: 'Google review link set',
          done:
            !!config &&
            !(config.sequences.review_request.google_review_link ?? 'REPLACE').includes('REPLACE'),
        },
        {
          key: 'reports',
          label: 'Weekly report recipients set',
          done: !!config && !config.reports.send_to.some((e) => e.endsWith('@example.com')),
        },
        {
          key: 'whatsapp',
          label: 'WhatsApp number connected',
          done: Boolean(routing?.waPhoneNumberId && token),
        },
        {
          key: 'templates',
          label: `WhatsApp templates approved (${GO_LIVE_TEMPLATES.filter((k) => approvedKeys.has(k)).length}/${GO_LIVE_TEMPLATES.length})`,
          done: GO_LIVE_TEMPLATES.every((k) => approvedKeys.has(k)),
        },
        { key: 'test', label: 'Real WhatsApp message delivered', done: Boolean(realSend) },
      ];
      return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
    });
  });

  // "Test" buttons in Settings → Integrations.
  app.post('/v1/integrations/test', { preHandler: admins }, async (req, reply) => {
    const { kind } = z.strictObject({ kind: z.enum(['whatsapp', 'email']) }).parse(req.body);
    const tenantId = tenantOf(req);
    try {
      if (kind === 'whatsapp') {
        const routing = await ctx.system.getTenantRouting(tenantId);
        const token = await withTenant(ctx.db, tenantId, (tx) =>
          getTenantSecret(tx, ctx.secretsKey, tenantId, 'whatsapp_access_token'),
        );
        if (!routing?.waPhoneNumberId || !token)
          return {
            ok: false,
            message: ctx.allowFakeChannel
              ? 'Not connected: mock mode uses the fake channel.'
              : 'Not connected.',
          };
        const info = await verifyWhatsAppNumber({
          accessToken: token,
          phoneNumberId: routing.waPhoneNumberId,
          fetch: ctx.fetch,
        });
        return {
          ok: true,
          message: `Connected to ${info.verifiedName ?? 'WhatsApp'} (${info.displayPhoneNumber ?? routing.waPhoneNumberId}), quality ${info.qualityRating ?? 'unknown'}.`,
        };
      }
      const config = (await withTenant(ctx.db, tenantId, getActiveConfig))?.config;
      const to = config?.reports.send_to ?? [];
      if (!to.length) return { ok: false, message: 'Add a report recipient first.' };
      await ctx.email.send({
        to,
        subject: `${config?.brand.business_name ?? 'InstantLead'}: test email`,
        text: 'This is a test from InstantLead. Weekly reports and staff alerts will arrive like this.',
      });
      return {
        ok: true,
        message: `Test email sent to ${to.join(', ')}${ctx.email.provider === 'fake' ? ' (mock mode: not really sent)' : ''}.`,
      };
    } catch (err) {
      return reply.code(200).send({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // Agency admin: volume and running cost per tenant this month (protects margin).
  app.get('/v1/admin/usage', { preHandler: agency }, async () => {
    const now = ctx.clock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { since: monthStart.toISOString(), tenants: await ctx.system.usageSince(monthStart) };
  });

  // API keys for the client's website/CRM (shown once on creation; only the hash is stored).
  app.get('/v1/api-keys', { preHandler: admins }, (req) =>
    withTenant(ctx.db, tenantOf(req), (tx) =>
      tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .orderBy(desc(apiKeys.createdAt)),
    ),
  );
  app.post('/v1/api-keys', { preHandler: admins }, async (req, reply) => {
    const { name } = z.strictObject({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const key = await ctx.system.createApiKey(tenantOf(req), name, actor(req.principal));
    return reply.code(201).send({ key });
  });
  app.delete('/v1/api-keys/:id', { preHandler: admins }, async (req, reply) => {
    const id = leadParam(req);
    const rows = await withTenant(ctx.db, tenantOf(req), async (tx) => {
      const r = await tx
        .update(apiKeys)
        .set({ revokedAt: ctx.clock.now() })
        .where(eq(apiKeys.id, id))
        .returning({ id: apiKeys.id });
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'api_key.revoked',
        entityType: 'api_key',
        entityId: id,
      });
      return r;
    });
    return rows.length ? { revoked: true } : reply.code(404).send({ error: 'not_found' });
  });

  // ---- Reports ----

  app.get('/v1/reports', { preHandler: staff }, (req) => withTenant(ctx.db, tenantOf(req), listReports));

  // Preview / live funnel: any window (default: the last 7 days up to now). Same numbers as the weekly email.
  app.get('/v1/reports/preview', { preHandler: staff }, async (req) => {
    const q = z
      .object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(req.query);
    const now = ctx.clock.now();
    const end = q.to ? new Date(q.to) : now;
    const start = q.from ? new Date(q.from) : new Date(end.getTime() - 7 * 86_400_000);
    return withTenant(ctx.db, tenantOf(req), async (tx) => {
      const config = (await getActiveConfig(tx))?.config;
      if (!config) throw new Error('tenant has no config');
      const data = await computeReport(tx, config, start, end, now);
      return { data, email: renderReportEmail(config.brand.business_name, data) };
    });
  });

  // ---- Monitoring ----

  app.get('/v1/health', { preHandler: staff }, (req) => withTenant(ctx.db, tenantOf(req), integrationHealth));

  app.get('/v1/admin/monitoring', { preHandler: agency }, async () => ({
    alerts: await ctx.system.recentAlerts(),
    deadLetters: await ctx.system.deadLetters(),
  }));

  app.post('/v1/admin/monitoring/run', { preHandler: agency }, () =>
    runMonitor({
      system: ctx.system,
      email: ctx.email,
      alertEmail: ctx.env.ALERT_EMAIL,
      now: () => ctx.clock.now(),
    }),
  );

  // Inbox list with the few filters the UI needs.
  app.get('/v1/inbox', { preHandler: staff }, async (req) => {
    const q = z
      .object({ state: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query);
    return withTenant(ctx.db, tenantOf(req), (tx) =>
      tx
        .select({
          id: leads.id,
          name: leads.name,
          phone: leads.phoneE164,
          source: leads.source,
          state: leads.state,
          tier: leads.tier,
          score: leads.score,
          aiPaused: leads.aiPaused,
          notALead: leads.notALead,
          receivedAt: leads.receivedAt,
          lastInboundAt: conversations.lastInboundAt,
        })
        .from(leads)
        .leftJoin(conversations, eq(conversations.leadId, leads.id))
        .where(q.state ? eq(leads.state, q.state as typeof leads.$inferSelect.state) : undefined)
        .orderBy(desc(leads.receivedAt))
        .limit(q.limit),
    );
  });
}
