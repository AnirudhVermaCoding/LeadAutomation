import { createHmac } from 'node:crypto';
import { createFakeEmail } from '@instantlead/integrations';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, META_APP_SECRET, PASSWORD, type TestContext } from '../test/context.ts';
import { withTenant } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { enrollments, leads, templates } from './db/schema.ts';
import { runMonitor } from './monitoring.ts';
import { sendToLead } from './outbound.ts';

const WABA = '555000111222';
const PHONE_ID = '111222333';
const calls: { url: string; body: unknown }[] = [];
let failSendTo: string | null = null;
let wamid = 0;
const fakeGraph = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, body });
  if (url.includes('/message_templates')) {
    if (!url.includes('after=p2'))
      return new Response(
        JSON.stringify({
          data: [
            { id: '1', name: 'il_first_reply', language: 'en', status: 'APPROVED', category: 'UTILITY' },
            {
              id: '2',
              name: 'il_followup_day2',
              language: 'en_US',
              status: 'APPROVED',
              category: 'MARKETING',
            },
            { id: '3', name: 'il_cancellation', language: 'hi', status: 'REJECTED', category: 'UTILITY' },
          ],
          paging: { next: `https://graph.facebook.com/v23.0/${WABA}/message_templates?after=p2` },
        }),
      );
    return new Response(
      JSON.stringify({
        data: [
          { id: '4', name: 'il_reminder_24h', language: 'en', status: 'PENDING', category: 'UTILITY' },
          {
            id: '5',
            name: 'someone_elses_template',
            language: 'en',
            status: 'APPROVED',
            category: 'UTILITY',
          },
        ],
      }),
    );
  }
  if (url.includes('/messages')) {
    const to = (body as { to?: string } | undefined)?.to;
    if (failSendTo && to === failSendTo)
      return new Response(
        JSON.stringify({
          error: { code: 131050, message: 'Recipient has chosen to stop receiving marketing messages' },
        }),
        { status: 400 },
      );
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${++wamid}` }] }));
  }
  return new Response('{}');
}) as typeof fetch;

let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

beforeAll(async () => {
  t = await createTestContext({ fetch: fakeGraph });
  A = (
    await t.ctx.system.createTenant(
      {
        slug: 'a',
        name: 'Smile Dental',
        preset: 'clinic_dental',
        admin: { email: 'admin@a.test', name: 'A', password: PASSWORD },
      },
      { type: 'system' },
    )
  ).tenant.id;
  cookie = await t.signIn('admin@a.test');
  await t.app.inject({
    method: 'PUT',
    url: '/v1/integrations/whatsapp',
    headers: { cookie },
    payload: { id: PHONE_ID, access_token: 'x'.repeat(30), waba_id: WABA },
  });
});
afterAll(() => t.close());

const sign = (body: string) => `sha256=${createHmac('sha256', META_APP_SECRET).update(body).digest('hex')}`;
const deliver = (payload: object) => {
  const body = JSON.stringify(payload);
  return t.app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    payload: body,
  });
};
const templateChange = (field: string, value: object) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field, value }] }],
});
const tpl = async (providerName: string, language: string) =>
  withTenant(
    t.ctx.db,
    A,
    async (tx) =>
      (
        await tx
          .select()
          .from(templates)
          .where(and(eq(templates.providerName, providerName), eq(templates.language, language)))
      )[0]!,
  );
const approveAll = () => t.owner.query(`update templates set status = 'approved' where tenant_id = $1`, [A]);
const newLead = async () => {
  const phone = `98750${String(++n).padStart(5, '0')}`;
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/leads',
    headers: { cookie },
    payload: { phone, name: 'Neha', consent: { granted: true } },
  });
  const leadId = (res.json() as { lead_id: string }).lead_id;
  return { leadId, phone, e164: `+91${phone}` };
};

describe('template approval synced from Meta', () => {
  test('saving the WABA id syncs every template (paged), mapping Meta statuses and ignoring foreign templates', async () => {
    const results = await t.drainJobs();
    const sync = results.find((r) => r.queue === 'template-sync');
    expect(sync?.result).toEqual({ listed: 5, updated: 4 }); // 5 listed, 4 are ours
    expect(await tpl('il_first_reply', 'en')).toMatchObject({
      status: 'approved',
      providerStatus: 'APPROVED',
      category: 'utility',
    });
    expect(await tpl('il_followup_day2', 'en')).toMatchObject({ status: 'approved', category: 'marketing' }); // en_US -> en
    expect(await tpl('il_cancellation', 'hi')).toMatchObject({
      status: 'rejected',
      providerStatus: 'REJECTED',
    });
    expect(await tpl('il_reminder_24h', 'en')).toMatchObject({ status: 'submitted' });
    expect(
      calls.some((c) =>
        c.url.includes('/555000111222/message_templates?fields=name,language,status,category'),
      ),
    ).toBe(true);
  });

  test('the Sync button needs a WABA id; with one it queues a sync', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/templates/sync',
      headers: { cookie },
      payload: {},
    });
    expect(res.json()).toEqual({ queued: true });
    expect((await t.drainJobs()).some((r) => r.queue === 'template-sync')).toBe(true);
  });

  test('a PAUSED webhook blocks the template and alerts the agency; REINSTATED restores it', async () => {
    const event = (e: string) =>
      templateChange('message_template_status_update', {
        event: e,
        message_template_id: 1,
        message_template_name: 'il_first_reply',
        message_template_language: 'en',
        reason: e === 'PAUSED' ? 'Low quality' : null,
      });
    expect((await deliver(event('PAUSED'))).statusCode).toBe(200);
    expect(await tpl('il_first_reply', 'en')).toMatchObject({
      status: 'rejected',
      providerStatus: 'PAUSED',
      statusReason: 'Low quality',
    });

    // Sending with it now fails loudly instead of silently.
    const { leadId } = await newLead();
    expect(await t.drainJobs()).toMatchObject([
      { result: { status: 'failed', reason: expect.stringMatching(/not approved/) } },
    ]);
    expect(leadId).toBeTruthy();

    const email = createFakeEmail();
    await runMonitor({
      system: t.ctx.system,
      email,
      alertEmail: 'ops@agency.test',
      now: () => t.clock.now(),
    });
    expect(email.sent.some((m) => /paused or disabled 1 WhatsApp template.*first_reply/.test(m.text))).toBe(
      true,
    );

    await deliver(event('REINSTATED'));
    expect(await tpl('il_first_reply', 'en')).toMatchObject({
      status: 'approved',
      providerStatus: 'REINSTATED',
    });
  });

  test('a category update from Meta is stored (cost tracking)', async () => {
    await deliver(
      templateChange('message_template_category_update', {
        message_template_name: 'il_followup_day2',
        message_template_language: 'en',
        new_category: 'UTILITY',
      }),
    );
    expect((await tpl('il_followup_day2', 'en')).category).toBe('utility');
    // Unknown WABA: ignored, not an error.
    const stranger = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '999',
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                event: 'APPROVED',
                message_template_name: 'il_first_reply',
                message_template_language: 'en',
              },
            },
          ],
        },
      ],
    };
    expect((await deliver(stranger)).statusCode).toBe(200);
  });
});

describe('customers who stopped marketing messages (131050)', () => {
  test('the user_preferences webhook stops marketing and follow-ups, keeps utility messages, and resume undoes it', async () => {
    await approveAll();
    const { leadId, e164, phone } = await newLead();
    await t.drainJobs(); // first reply + follow-up enrolment
    const prefs = (value: 'stop' | 'resume') => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: 'user_preferences',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_ID },
                contacts: [{ wa_id: `91${phone}` }],
                user_preferences: [
                  {
                    wa_id: `91${phone}`,
                    detail: 'x',
                    category: 'marketing_messages',
                    value,
                    timestamp: 1731705721,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect((await deliver(prefs('stop'))).statusCode).toBe(200);
    const [lead] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId)));
    expect(lead?.marketingOptOutAt).not.toBeNull();
    const [enr] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(enrollments).where(eq(enrollments.leadId, leadId)),
    );
    expect(enr).toMatchObject({ status: 'stopped', stopReason: 'marketing_opt_out' });

    expect(
      await sendToLead(t.ctx, A, { leadId, idempotencyKey: 'mk:1', template: { key: 'followup_day2' } }),
    ).toEqual({ status: 'skipped', reason: 'stopped marketing messages' });
    expect(
      await sendToLead(t.ctx, A, {
        leadId,
        idempotencyKey: 'ut:1',
        template: { key: 'reminder_2h', values: { 'appointment.time': 'tomorrow' } },
      }),
    ).toMatchObject({ status: 'sent' });
    expect(e164).toBeTruthy();

    await deliver(prefs('resume'));
    expect(
      (await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId))))[0]
        ?.marketingOptOutAt,
    ).toBeNull();
    expect(
      await sendToLead(t.ctx, A, { leadId, idempotencyKey: 'mk:2', template: { key: 'followup_day2' } }),
    ).toMatchObject({ status: 'sent' });
  });

  test('error 131050 from a delivery status marks the customer', async () => {
    const { leadId } = await newLead();
    const [sent] = (await t.drainJobs()).map((r) => r.result as { providerMessageId: string });
    const status = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_ID },
                statuses: [
                  {
                    id: sent!.providerMessageId,
                    status: 'failed',
                    timestamp: '1790000000',
                    errors: [{ code: 131050, title: 'Recipient chose to stop marketing messages' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await deliver(status);
    expect(
      (await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId))))[0]
        ?.marketingOptOutAt,
    ).not.toBeNull();
  });

  test('error 131050 returned when sending is remembered too, and not retried', async () => {
    const { leadId, phone } = await newLead();
    await t.drainJobs();
    await t.owner.query(`update leads set marketing_opt_out_at = null where id = $1`, [leadId]);
    failSendTo = `91${phone}`;
    const r = await sendToLead(t.ctx, A, {
      leadId,
      idempotencyKey: 'mk:fail',
      template: { key: 'followup_day5' },
    });
    failSendTo = null;
    expect(r).toMatchObject({ status: 'failed' });
    expect(
      (await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId))))[0]
        ?.marketingOptOutAt,
    ).not.toBeNull();
  });
});

describe('new template keys reach existing clinics', () => {
  test('migrate backfills missing template rows without touching approval status', async () => {
    await t.owner.query(`delete from templates where tenant_id = $1 and key = 'cancellation'`, [A]);
    await t.owner.query(
      `update templates set status = 'approved' where tenant_id = $1 and key = 'first_reply' and language = 'en'`,
      [A],
    );
    await migrate(t.ctx.env.DATABASE_OWNER_URL, t.ctx.env.DATABASE_URL);
    const rows = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(templates).where(eq(templates.key, 'cancellation')),
    );
    expect(rows.map((r) => r.language).sort()).toEqual(['en', 'hi']);
    expect(rows.every((r) => r.status === 'draft' && r.providerName === 'il_cancellation')).toBe(true);
    expect((await tpl('il_first_reply', 'en')).status).toBe('approved');
  });
});
