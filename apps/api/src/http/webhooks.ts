import { randomUUID } from 'node:crypto';
import { toE164 } from '@instantlead/core';
import {
  MEDIA_TYPES,
  metaVerificationChallenge,
  parseMetaWebhook,
  verifyMetaSignature,
} from '@instantlead/integrations';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '../db/client.ts';
import { templates } from '../db/schema.ts';
import { handleInboundMessage, handleStatusUpdate, handleUserPreference } from '../inbound.ts';
import { applyTemplateStatuses, languageOf } from '../template-sync.ts';
import { QUEUES } from '../jobs.ts';
import { runScheduledReports } from '../reports.ts';
import { runStaffDigest } from '../staff-digest.ts';
import { sweepCalendars } from '../calendar-sync.ts';
import { sweepDueSteps } from '../sequences.ts';
import { sweepOpportunities } from '../opportunities.ts';
import type { AppContext } from '../system/context.ts';
import { guard } from './auth.ts';

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext) {
  // Signatures are computed over the exact bytes Meta sent, so this scope keeps JSON bodies raw.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    scope.get('/webhooks/meta', (req, reply) => {
      const token = ctx.env.META_VERIFY_TOKEN;
      const challenge = token ? metaVerificationChallenge(req.query as Record<string, unknown>, token) : null;
      return challenge === null ? reply.code(403).send() : reply.type('text/plain').send(challenge);
    });

    scope.post('/webhooks/meta', async (req, reply) => {
      const secret = ctx.env.META_APP_SECRET;
      if (!secret) return reply.code(503).send({ error: 'meta_not_configured' });
      const raw = req.body as Buffer;
      if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, secret))
        return reply.code(401).send({ error: 'bad_signature' });

      let events;
      try {
        events = parseMetaWebhook(JSON.parse(raw.toString('utf8')));
      } catch {
        return reply.code(400).send({ error: 'bad_payload' });
      }

      // Process before acknowledging: if we fail, Meta retries, and processing is idempotent.
      for (const e of events) {
        const tenantId =
          e.type === 'leadgen'
            ? await ctx.system.findTenantIdBy('metaPageId', e.pageId)
            : e.type === 'template_status' || e.type === 'template_category'
              ? await ctx.system.findTenantIdBy('wabaId', e.wabaId)
              : await ctx.system.findTenantIdBy('waPhoneNumberId', e.phoneNumberId);
        if (!tenantId) {
          req.log.warn({ type: e.type }, 'webhook for an unknown number/page; ignored');
          continue;
        }
        if (e.type === 'message')
          await handleInboundMessage(ctx, tenantId, {
            provider: 'meta',
            providerMessageId: e.providerMessageId,
            from: e.from,
            text: e.text,
            mediaType: e.mediaType,
            buttonPayload: e.buttonPayload,
            referral: e.referral,
            profileName: e.profileName,
          });
        else if (e.type === 'status') await handleStatusUpdate(ctx, tenantId, e);
        else if (e.type === 'template_status')
          await withTenant(ctx.db, tenantId, (tx) =>
            applyTemplateStatuses(tx, ctx.clock, [
              { name: e.name, language: e.language, status: e.event, category: e.category, reason: e.reason },
            ]),
          );
        else if (e.type === 'template_category')
          await withTenant(ctx.db, tenantId, async (tx) => {
            const language = languageOf(e.language);
            const category =
              e.newCategory.toUpperCase() === 'MARKETING'
                ? 'marketing'
                : e.newCategory.toUpperCase() === 'UTILITY'
                  ? 'utility'
                  : null;
            if (language && category)
              await tx
                .update(templates)
                .set({ category })
                .where(and(eq(templates.providerName, e.name), eq(templates.language, language)));
          });
        else if (e.type === 'user_preference') await handleUserPreference(ctx, tenantId, e);
        // Meta may retry a webhook; a duplicate job just finds the lead already exists.
        else
          await ctx.enqueue(null, QUEUES.metaLeadgen, { tenantId, leadgenId: e.leadgenId, formId: e.formId });
      }
      return { ok: true };
    });
  });

  // Mock mode: play the lead's side of a WhatsApp conversation (Demo Sandbox, simulator, tests).
  const FakeInbound = z.strictObject({
    from: z.string(),
    text: z.string().min(1).max(4096).optional(),
    button_payload: z.string().optional(),
    profile_name: z.string().optional(),
    referral: z.strictObject({ source_type: z.string(), headline: z.string().optional() }).optional(),
    /** Simulate a photo, voice note, sticker…; text is then the caption (if any). */
    media_type: z.enum(MEDIA_TYPES).optional(),
  });
  app.post(
    '/v1/dev/whatsapp/inbound',
    { preHandler: guard(ctx, ['client_admin', 'client_staff', 'agency_admin'], { tenant: true }) },
    async (req, reply) => {
      if (!ctx.allowFakeChannel) return reply.code(404).send({ error: 'not_found' });
      const body = FakeInbound.parse(req.body);
      const from = toE164(body.from);
      if (!from) return reply.code(422).send({ error: 'invalid_phone' });
      return handleInboundMessage(ctx, req.tenantId as string, {
        provider: 'fake',
        providerMessageId: `fake.in.${randomUUID()}`,
        from,
        text: body.text ?? body.button_payload ?? (body.media_type ? `[${body.media_type}]` : ''),
        mediaType: body.media_type,
        buttonPayload: body.button_payload,
        profileName: body.profile_name,
        referral: body.referral && {
          sourceType: body.referral.source_type,
          headline: body.referral.headline,
        },
      });
    },
  );

  /**
   * Mock mode: fast-forward the (process-wide) business clock, then run due sequence steps,
   * so a demo can show day-2 follow-ups and reminders without waiting.
   */
  app.get(
    '/v1/dev/clock',
    { preHandler: guard(ctx, ['client_staff', 'client_admin', 'agency_admin'], { tenant: true }) },
    () => ({
      now: ctx.clock.now().toISOString(),
      canAdvance: ctx.allowFakeChannel && typeof (ctx.clock as { advance?: unknown }).advance === 'function',
    }),
  );

  app.post(
    '/v1/dev/clock/advance',
    { preHandler: guard(ctx, ['client_admin', 'agency_admin'], { tenant: true }) },
    async (req, reply) => {
      const clock = ctx.clock as { advance?: (ms: number) => void };
      if (!ctx.allowFakeChannel || typeof clock.advance !== 'function')
        return reply.code(404).send({ error: 'not_found' });
      const { hours } = z
        .strictObject({
          hours: z
            .number()
            .positive()
            .max(24 * 30),
        })
        .parse(req.body);
      clock.advance(hours * 3_600_000);
      const queued = await sweepDueSteps(ctx);
      await sweepCalendars(ctx);
      await sweepOpportunities(ctx);
      const reports = await runScheduledReports(ctx);
      await runStaffDigest(ctx);
      return { now: ctx.clock.now().toISOString(), steps_queued: queued, reports_sent: reports.length };
    },
  );
}
