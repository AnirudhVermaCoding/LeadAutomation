import { fillVariables, LANGUAGES, type TenantConfig } from '@instantlead/config';
import { parseLeadEmail } from '@instantlead/integrations';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getActiveConfig } from '../config-store.ts';
import { csvRecords } from '../csv.ts';
import { withTenant } from '../db/client.ts';
import { emit, IntakeError, intakeLead } from '../leads.ts';
import type { AppContext } from '../system/context.ts';
import { guard, type Principal } from './auth.ts';

const MAX_IMPORT_ROWS = 2000;

const noticeFor = (config: TenantConfig) =>
  fillVariables(config.intake.consent_notice_text, {
    business_name: config.brand.business_name,
    assistant_name: config.brand.assistant_name,
  });

const requestEvidence = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

const LeadBody = z.strictObject({
  phone: z.string().min(5),
  name: z.string().trim().max(200).optional(),
  email: z.email().optional(),
  language: z.enum(LANGUAGES).optional(),
  consent: z.strictObject({
    granted: z.literal(true, 'consent.granted must be true: leads can only be messaged with consent'),
    /** Exact text the lead agreed to; defaults to the tenant's configured notice. */
    notice_text: z.string().min(20).optional(),
    captured_at: z.iso.datetime({ offset: true }).optional(),
    ip: z.string().optional(),
    user_agent: z.string().optional(),
    page_url: z.url().optional(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const actorEvidence = (p: Principal | null) =>
  p?.kind === 'api_key' ? { apiKeyId: p.apiKeyId } : p?.kind === 'user' ? { userId: p.userId } : {};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** Hosted lead form, embeddable with <iframe src="…/f/FORM_KEY">. Same-origin post: no CORS needed. */
function formPage(config: TenantConfig, body: string) {
  const name = escapeHtml(config.brand.business_name);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:16px;color:#1a1a1a;background:#fff}
  form{max-width:420px;display:grid;gap:12px}
  label{display:grid;gap:4px;font-size:14px}
  input[type=text],input[type=tel],input[type=email]{font:inherit;padding:10px;border:1px solid #bbb;border-radius:6px}
  .consent{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#444}
  button{font:inherit;padding:12px;border:0;border-radius:6px;background:#128c4a;color:#fff;cursor:pointer}
  .hp{position:absolute;left:-9999px}
</style></head><body>${body}</body></html>`;
}

function formBody(config: TenantConfig, formKey: string, error?: string) {
  return `<form method="post" action="/f/${encodeURIComponent(formKey)}">
  <h2 style="margin:0">${escapeHtml(config.brand.business_name)}</h2>
  ${error ? `<p role="alert" style="color:#b00020">${escapeHtml(error)}</p>` : ''}
  <label>Name <input type="text" name="name" autocomplete="name" required maxlength="200"></label>
  <label>WhatsApp number <input type="tel" name="phone" autocomplete="tel" required></label>
  <label>Email (optional) <input type="email" name="email" autocomplete="email"></label>
  <label class="hp" aria-hidden="true">Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
  <label class="consent"><input type="checkbox" name="consent" value="yes" required> <span>${escapeHtml(noticeFor(config))}</span></label>
  <button type="submit">Send</button>
</form>`;
}

const FormBody = z.object({
  name: z.string().trim().max(200).optional(),
  phone: z.string().default(''),
  email: z.union([z.email(), z.literal('')]).optional(),
  consent: z.string().optional(),
  website: z.string().optional(),
});

export function registerIntakeRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  app.post(
    '/v1/leads',
    {
      preHandler: guard(ctx, ['api_key', 'client_admin', 'client_staff', 'agency_admin'], { tenant: true }),
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body = LeadBody.parse(req.body);
      const tenantId = req.tenantId as string;
      try {
        const result = await withTenant(ctx.db, tenantId, async (tx) => {
          const active = await getActiveConfig(tx);
          if (!active) throw new Error('tenant has no config');
          return intakeLead(tx, ctx, tenantId, {
            phone: body.phone,
            name: body.name,
            email: body.email,
            language: body.language,
            source: 'api',
            sourceDetails: body.metadata,
            consent: {
              source: 'api',
              noticeText: body.consent.notice_text ?? noticeFor(active.config),
              evidence: {
                capturedAt: body.consent.captured_at,
                ip: body.consent.ip,
                userAgent: body.consent.user_agent,
                pageUrl: body.consent.page_url,
                ...actorEvidence(req.principal),
              },
            },
          });
        });
        return reply.code(result.created ? 201 : 200).send({
          lead_id: result.leadId,
          created: result.created,
          suppressed: result.suppressed,
        });
      } catch (err) {
        if (err instanceof IntakeError)
          return reply.code(422).send({ error: 'invalid_lead', message: err.message });
        throw err;
      }
    },
  );

  // CSV columns: phone (required), consent (yes/true/1 required), name, email, language.
  app.post(
    '/v1/leads/import',
    { preHandler: guard(ctx, ['client_admin', 'agency_admin'], { tenant: true }) },
    async (req, reply) => {
      if (typeof req.body !== 'string') return reply.code(415).send({ error: 'send text/csv' });
      const rows = csvRecords(req.body);
      if (rows.length > MAX_IMPORT_ROWS)
        return reply
          .code(413)
          .send({ error: 'too_many_rows', message: `Import at most ${MAX_IMPORT_ROWS} rows at a time` });
      if (rows.length && !('phone' in rows[0]! && 'consent' in rows[0]!))
        return reply
          .code(400)
          .send({ error: 'bad_header', message: 'CSV needs "phone" and "consent" columns' });

      const tenantId = req.tenantId as string;
      const result = { imported: 0, existing: 0, skipped: [] as { row: number; reason: string }[] };
      for (const [i, row] of rows.entries()) {
        const rowNumber = i + 2; // 1-based, after the header
        if (!/^(yes|y|true|1|haan|ha)$/i.test(row.consent ?? '')) {
          result.skipped.push({ row: rowNumber, reason: 'no consent' });
          continue;
        }
        const language = LANGUAGES.find((l) => l === row.language?.toLowerCase());
        try {
          const r = await withTenant(ctx.db, tenantId, async (tx) => {
            const active = await getActiveConfig(tx);
            if (!active) throw new Error('tenant has no config');
            return intakeLead(tx, ctx, tenantId, {
              phone: row.phone ?? '',
              name: row.name || undefined,
              email: row.email || undefined,
              language,
              source: 'csv',
              consent: {
                source: 'csv',
                noticeText: noticeFor(active.config),
                evidence: { row: rowNumber, consentColumn: row.consent, ...actorEvidence(req.principal) },
              },
            });
          });
          if (r.created) result.imported++;
          else result.existing++;
        } catch (err) {
          if (!(err instanceof IntakeError)) throw err;
          result.skipped.push({ row: rowNumber, reason: err.message });
        }
      }
      return result;
    },
  );

  const formTenant = async (formKey: string) => {
    const tenantId = await ctx.system.findTenantIdBy('formKey', formKey);
    if (!tenantId) return null;
    const active = await withTenant(ctx.db, tenantId, getActiveConfig);
    return active && { tenantId, config: active.config };
  };

  // Portal lead emails (99acres, MagicBricks, Housing, Practo, JustDial…) forwarded here by Mailgun / SendGrid
  // inbound parse, a Cloudflare Email Worker, Zapier or Make. The secret key in the path identifies the clinic.
  const InboundMail = z.looseObject({
    from: z.string().optional(),
    sender: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    'body-plain': z.string().optional(),
    plain: z.string().optional(),
    html: z.string().optional(),
    'body-html': z.string().optional(),
  });
  app.post<{ Params: { key: string } }>(
    '/webhooks/email-in/:key',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const tenantId = await ctx.system.findTenantIdBy('emailInKey', req.params.key);
      if (!tenantId) return reply.code(404).send({ error: 'not_found' });
      const mail = InboundMail.safeParse(req.body);
      if (!mail.success) return reply.code(400).send({ error: 'invalid_request' });
      const m = mail.data;
      const parsed = parseLeadEmail({
        from: m.from ?? m.sender,
        subject: m.subject,
        text: m.text ?? m['body-plain'] ?? m.plain,
        html: m.html ?? m['body-html'],
      });
      // Always 200 once it is ours: providers retry on errors, and a retry would not help an unparseable email.
      if (!parsed.phone) {
        await withTenant(ctx.db, tenantId, (tx) =>
          emit(tx, ctx.clock, 'lead.email_unparsed', {
            portal: parsed.portal,
            subjectLength: m.subject?.length ?? 0,
          }),
        );
        return { ok: true, ignored: 'no phone number found' };
      }
      const phone = parsed.phone;
      const result = await withTenant(ctx.db, tenantId, async (tx) => {
        const active = await getActiveConfig(tx);
        if (!active) throw new Error('tenant has no config');
        return intakeLead(tx, ctx, tenantId, {
          phone,
          name: parsed.name ?? undefined,
          email: parsed.email ?? undefined,
          source: 'portal_email',
          sourceDetails: { portal: parsed.portal, message: parsed.message },
          consent: {
            source: 'portal_email',
            // The customer asked the portal to be contacted about this enquiry; the clinic confirms that basis (ONBOARDING).
            noticeText: `The customer sent an enquiry through ${parsed.portal ?? 'a listing portal'} and asked to be contacted about it.`,
            evidence: { portal: parsed.portal, from: m.from ?? m.sender ?? null, subject: m.subject ?? null },
          },
        });
      });
      return { ok: true, lead_id: result.leadId, created: result.created };
    },
  );

  app.get<{ Params: { formKey: string } }>('/f/:formKey', async (req, reply) => {
    const t = await formTenant(req.params.formKey);
    if (!t) return reply.code(404).type('text/html').send('Form not found');
    return reply.type('text/html').send(formPage(t.config, formBody(t.config, req.params.formKey)));
  });

  app.post<{ Params: { formKey: string } }>(
    '/f/:formKey',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const t = await formTenant(req.params.formKey);
      if (!t) return reply.code(404).type('text/html').send('Form not found');
      const form = FormBody.safeParse(req.body);
      const thanks = formPage(
        t.config,
        `<h2>Thank you!</h2><p>We'll message you on WhatsApp in a moment.</p>`,
      );
      if (!form.success)
        return reply
          .code(400)
          .type('text/html')
          .send(
            formPage(
              t.config,
              formBody(t.config, req.params.formKey, 'Please check the form and try again.'),
            ),
          );
      // Honeypot filled in: a bot. Pretend success, store nothing.
      if (form.data.website) return reply.type('text/html').send(thanks);
      if (form.data.consent !== 'yes')
        return reply
          .code(400)
          .type('text/html')
          .send(
            formPage(
              t.config,
              formBody(t.config, req.params.formKey, 'Please tick the consent box so we can contact you.'),
            ),
          );
      try {
        await withTenant(ctx.db, t.tenantId, (tx) =>
          intakeLead(tx, ctx, t.tenantId, {
            phone: form.data.phone,
            name: form.data.name,
            email: form.data.email || undefined,
            source: 'form',
            consent: {
              source: 'form',
              noticeText: noticeFor(t.config),
              evidence: {
                ...requestEvidence(req),
                referer: req.headers.referer,
                formKey: req.params.formKey,
              },
            },
          }),
        );
      } catch (err) {
        if (!(err instanceof IntakeError)) throw err;
        return reply
          .code(400)
          .type('text/html')
          .send(
            formPage(
              t.config,
              formBody(t.config, req.params.formKey, 'Please enter a valid WhatsApp number.'),
            ),
          );
      }
      return reply.type('text/html').send(thanks);
    },
  );
}
