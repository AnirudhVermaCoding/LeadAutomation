import { createHmac } from 'node:crypto';
import { HOUR } from '@instantlead/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, META_APP_SECRET, PASSWORD, type TestContext } from '../test/context.ts';
import { withTenant } from './db/client.ts';
import { consents, leads, messages, suppressions } from './db/schema.ts';
import { sendToLead } from './outbound.ts';

// Stand-in for graph.facebook.com: records calls, answers sends and lead fetches.
const graphCalls: { url: string; body: unknown }[] = [];
const fakeGraph = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  graphCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.includes('/messages'))
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${graphCalls.length}` }] }));
  return new Response(
    JSON.stringify({
      form_id: '7777',
      field_data: [
        { name: 'full_name', values: ['Meera Iyer'] },
        { name: 'phone_number', values: ['+919811112222'] },
      ],
    }),
  );
}) as typeof fetch;

let t: TestContext;
let A: string;
let B: string;
let keyA: string;
let adminA: string;

beforeAll(async () => {
  t = await createTestContext({ fetch: fakeGraph });
  const actor = { type: 'system' } as const;
  A = (
    await t.ctx.system.createTenant(
      {
        slug: 'a',
        name: 'Smile Dental',
        preset: 'clinic_dental',
        admin: { email: 'admin@a.test', name: 'A', password: PASSWORD },
      },
      actor,
    )
  ).tenant.id;
  B = (await t.ctx.system.createTenant({ slug: 'b', name: 'Other Clinic', preset: 'clinic_skin' }, actor))
    .tenant.id;
  keyA = await t.ctx.system.createApiKey(A, 'website', actor);
  adminA = await t.signIn('admin@a.test');
});
afterAll(() => t.close());

const postLead = (payload: object, key = keyA) =>
  t.app.inject({ method: 'POST', url: '/v1/leads', headers: { authorization: `Bearer ${key}` }, payload });
const consent = { granted: true };
const inbound = (payload: object) =>
  t.app.inject({ method: 'POST', url: '/v1/dev/whatsapp/inbound', headers: { cookie: adminA }, payload });
const leadByPhone = (tenantId: string, phone: string) =>
  withTenant(
    t.ctx.db,
    tenantId,
    async (tx) => (await tx.select().from(leads).where(eq(leads.phoneE164, phone)))[0],
  );
const thread = (tenantId: string, leadId: string) =>
  withTenant(t.ctx.db, tenantId, (tx) => tx.select().from(messages).where(eq(messages.leadId, leadId)));

describe('intake -> instant first reply', () => {
  test('API lead gets consent recorded and an approved-template first reply via the job queue', async () => {
    const res = await postLead({ phone: '98765 43210', name: 'Priya Sharma', consent });
    expect(res.statusCode).toBe(201);
    const leadId = (res.json() as { lead_id: string }).lead_id;

    const lead = await leadByPhone(A, '+919876543210');
    expect(lead).toMatchObject({ id: leadId, state: 'new', source: 'api', name: 'Priya Sharma' });
    const [c] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(consents).where(eq(consents.leadId, leadId)),
    );
    expect(c?.noticeText).toContain('Smile Dental may contact you on WhatsApp');

    const results = await t.drainJobs();
    expect(results).toMatchObject([{ queue: 'first-reply', result: { status: 'sent' } }]);
    const [msg] = await thread(A, leadId);
    expect(msg).toMatchObject({
      direction: 'out',
      kind: 'template',
      templateKey: 'first_reply',
      templateCategory: 'utility',
      provider: 'fake',
      status: 'sent',
    });
    expect(msg?.body).toMatch(/^Hi Priya, thanks for your enquiry with Smile Dental! I am Asha/);
    expect((await leadByPhone(A, '+919876543210'))?.state).toBe('contacted');

    // Running the same job again (e.g. a retry) sends nothing new.
    expect(await (await import('./workers.ts')).sendFirstReply(t.ctx, { tenantId: A, leadId })).toEqual({
      status: 'skipped',
      reason: 'already sent',
    });
  });

  test('duplicate submissions dedupe by phone and do not re-trigger the first reply', async () => {
    const res = await postLead({ phone: '+91 98765-43210', email: 'priya@example.com', consent });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: false });
    expect(await t.drainJobs()).toEqual([]);
    expect((await leadByPhone(A, '+919876543210'))?.email).toBe('priya@example.com');
  });

  test('no consent, no lead; bad phone is a readable 422', async () => {
    expect((await postLead({ phone: '9876500000', consent: { granted: false } })).statusCode).toBe(400);
    expect((await postLead({ phone: '9876500000' })).statusCode).toBe(400);
    const bad = await postLead({ phone: '12345', consent });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'invalid_lead' });
  });
});

describe('WhatsApp rules', () => {
  test('a lead who messages first (click-to-WhatsApp) is a lead with conversation consent and an open window', async () => {
    const res = await inbound({
      from: '9822233344',
      text: 'Hi, how much is teeth whitening?',
      profile_name: 'Arjun',
      referral: { source_type: 'ad', headline: 'Whitening offer' },
    });
    expect(res.json()).toMatchObject({ action: 'recorded' });
    const lead = await leadByPhone(A, '+919822233344');
    expect(lead).toMatchObject({ source: 'click_to_whatsapp', state: 'qualifying', name: 'Arjun' });
    // No template first reply for inbound-first leads (the AI answers in the open window, M3).
    expect(await t.drainJobs()).toEqual([]);
    const sent = await sendToLead(t.ctx, A, {
      leadId: lead!.id,
      idempotencyKey: 'test:free-form-1',
      freeForm: { kind: 'text', body: 'Whitening starts at ₹8,000.' },
    });
    expect(sent.status).toBe('sent');
  });

  test('outside the 24 h window free-form is refused, and a template is used when provided', async () => {
    const lead = (await leadByPhone(A, '+919822233344'))!;
    t.clock.advance(25 * HOUR);
    const refused = await sendToLead(t.ctx, A, {
      leadId: lead.id,
      idempotencyKey: 'test:free-form-2',
      freeForm: { kind: 'text', body: 'Still there?' },
    });
    expect(refused).toMatchObject({ status: 'failed', reason: expect.stringMatching(/24-hour/) });

    const fallback = await sendToLead(t.ctx, A, {
      leadId: lead.id,
      idempotencyKey: 'test:followup',
      freeForm: { kind: 'text', body: 'Still there?' },
      template: { key: 'followup_day2' },
    });
    expect(fallback.status).toBe('sent');
    const rows = await thread(A, lead.id);
    expect(rows.find((m) => m.idempotencyKey === 'test:followup')).toMatchObject({
      kind: 'template',
      templateCategory: 'marketing',
      estCostInr: expect.any(Number),
    });
  });

  test('STOP opts out immediately and permanently, even if the lead fills the form again', async () => {
    expect((await inbound({ from: '9822233344', text: 'STOP' })).json()).toMatchObject({
      action: 'opted_out',
    });
    const lead = (await leadByPhone(A, '+919822233344'))!;
    expect(lead.state).toBe('opted_out');
    expect(
      await sendToLead(t.ctx, A, {
        leadId: lead.id,
        idempotencyKey: 'test:after-stop',
        template: { key: 'followup_day5' },
      }),
    ).toEqual({ status: 'skipped', reason: 'opted out' });

    // Replies after opting out are recorded but change nothing.
    expect((await inbound({ from: '9822233344', text: 'hello?' })).json()).toMatchObject({
      action: 'ignored_opted_out',
    });
    // A new form submission does not re-subscribe them.
    const again = await postLead({ phone: '9822233344', consent });
    expect(again.json()).toMatchObject({ suppressed: true });
    expect(await t.drainJobs()).toEqual([]);
  });

  test('opt-out survives erasure of the lead (suppression is a keyed hash, not the phone)', async () => {
    const lead = (await leadByPhone(A, '+919822233344'))!;
    await t.owner.query('delete from leads where id = $1', [lead.id]);
    const res = await postLead({ phone: '9822233344', consent });
    expect(res.json()).toMatchObject({ created: true, suppressed: true });
    expect((await leadByPhone(A, '+919822233344'))?.state).toBe('opted_out');
    expect(await t.drainJobs()).toEqual([]);
    const rows = await withTenant(t.ctx.db, A, (tx) => tx.select().from(suppressions));
    expect(JSON.stringify(rows)).not.toContain('9822233344');
  });

  test('Hindi/Hinglish opt-out keywords and the Stop button work; ordinary messages do not opt out', async () => {
    await inbound({ from: '9833300001', text: 'stop nahi, kal ka slot chahiye' });
    expect((await leadByPhone(A, '+919833300001'))?.state).toBe('qualifying');
    await inbound({ from: '9833300002', text: 'बंद करो' });
    expect((await leadByPhone(A, '+919833300002'))?.state).toBe('opted_out');
    await inbound({ from: '9833300003', button_payload: 'first_reply:stop' });
    expect((await leadByPhone(A, '+919833300003'))?.state).toBe('opted_out');
  });
});

describe('Meta webhooks', () => {
  const sign = (body: string) => `sha256=${createHmac('sha256', META_APP_SECRET).update(body).digest('hex')}`;
  const deliver = (payload: object, signature?: string) => {
    const body = JSON.stringify(payload);
    return t.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(body) },
      payload: body,
    });
  };
  const waMessage = (id: string, text: string, phoneNumberId = '111222333') => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Kavya' }, wa_id: '919844455566' }],
              messages: [
                { from: '919844455566', id, timestamp: '1790000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });

  beforeAll(async () => {
    // Connect tenant A's WhatsApp number and Facebook page.
    for (const [path, id] of [
      ['whatsapp', '111222333'],
      ['lead-ads', '444555666'],
    ] as const) {
      const res = await t.app.inject({
        method: 'PUT',
        url: `/v1/integrations/${path}`,
        headers: { cookie: adminA },
        payload: { id, access_token: 'EAAG-test-token-0123456789' },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  test('verification handshake and signature check', async () => {
    const ok = await t.app.inject({
      url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=42',
    });
    expect(ok.body).toBe('42');
    expect((await deliver(waMessage('wamid.forged', 'hi'), 'sha256=00')).statusCode).toBe(401);
  });

  test('inbound message routes to the tenant owning the number, once even if delivered twice', async () => {
    const payload = waMessage('wamid.IN1', 'Do you open on Sunday?');
    expect((await deliver(payload)).statusCode).toBe(200);
    expect((await deliver(payload)).statusCode).toBe(200);
    const lead = (await leadByPhone(A, '+919844455566'))!;
    expect(lead).toMatchObject({ source: 'whatsapp', name: 'Kavya' });
    expect((await thread(A, lead.id)).filter((m) => m.direction === 'in')).toHaveLength(1);
    expect(await leadByPhone(B, '+919844455566')).toBeUndefined();
  });

  test('with WhatsApp connected, unapproved templates are refused; approved ones go out via Cloud API', async () => {
    await postLead({ phone: '9855566677', name: 'Rohan', consent });
    expect(await t.drainJobs()).toMatchObject([
      { result: { status: 'failed', reason: expect.stringMatching(/not approved/) } },
    ]);

    const approve = await t.app.inject({
      method: 'PUT',
      url: '/v1/templates/first_reply/en',
      headers: { cookie: adminA },
      payload: { status: 'approved' },
    });
    expect(approve.statusCode).toBe(200);
    const lead = (await leadByPhone(A, '+919855566677'))!;
    const sent = await (await import('./workers.ts')).sendFirstReply(t.ctx, { tenantId: A, leadId: lead.id });
    expect(sent).toMatchObject({ status: 'sent', providerMessageId: expect.stringMatching(/^wamid\./) });

    const call = graphCalls.findLast((c) => c.url.endsWith('/v23.0/111222333/messages'));
    expect(call?.body).toMatchObject({
      to: '919855566677',
      type: 'template',
      template: { name: 'il_first_reply', language: { code: 'en' } },
    });
  });

  test('delivery status updates the message and never goes backwards', async () => {
    const lead = (await leadByPhone(A, '+919855566677'))!;
    const sent = (await thread(A, lead.id)).find((m) => m.status === 'sent')!;
    const status = (s: string) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '1', phone_number_id: '111222333' },
                statuses: [
                  {
                    id: sent.providerMessageId,
                    status: s,
                    timestamp: '1790000100',
                    recipient_id: '919855566677',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await deliver(status('read'));
    await deliver(status('delivered'));
    const [after] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(messages).where(eq(messages.id, sent.id)),
    );
    expect(after?.status).toBe('read');
  });

  test('Lead Ads: webhook -> fetch the lead from Graph -> intake with consent evidence', async () => {
    const res = await deliver({
      object: 'page',
      entry: [
        {
          id: '444555666',
          changes: [
            { field: 'leadgen', value: { leadgen_id: '9001', page_id: '444555666', form_id: '7777' } },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const results = await t.drainJobs();
    expect(results[0]).toMatchObject({ queue: 'meta-leadgen', result: { created: true } });
    const lead = (await leadByPhone(A, '+919811112222'))!;
    expect(lead).toMatchObject({ source: 'meta_lead_ads', name: 'Meera Iyer' });
    const [c] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(consents).where(eq(consents.leadId, lead.id)),
    );
    expect(c).toMatchObject({ source: 'meta_lead_ads', evidence: { leadgenId: '9001' } });
  });
});

describe('hosted form and CSV import', () => {
  test('form renders the consent notice, requires the checkbox, ignores bots', async () => {
    const formUrl = (
      (await t.app.inject({ url: '/v1/integrations', headers: { cookie: adminA } })).json() as {
        form_url: string;
      }
    ).form_url;
    const path = new URL(formUrl).pathname;
    const page = await t.app.inject({ url: path });
    expect(page.body).toContain('Smile Dental may contact you on WhatsApp');

    const submit = (form: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(form).toString(),
      });
    expect((await submit({ name: 'Neha', phone: '9866600011' })).statusCode).toBe(400);
    expect(
      (await submit({ name: 'Bot', phone: '9866600022', consent: 'yes', website: 'spam.example' }))
        .statusCode,
    ).toBe(200);
    expect(await leadByPhone(A, '+919866600022')).toBeUndefined();
    expect((await submit({ name: 'Neha', phone: '9866600011', consent: 'yes' })).statusCode).toBe(200);
    expect(await leadByPhone(A, '+919866600011')).toMatchObject({ source: 'form', name: 'Neha' });
  });

  test('CSV import needs a consent column and reports skipped rows', async () => {
    const csv =
      'phone,name,consent\n9877700001,Asha,yes\n9877700002,Ravi,no\nnot-a-phone,X,yes\n9877700001,Asha again,yes\n';
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/leads/import',
      headers: { cookie: adminA, 'content-type': 'text/csv' },
      payload: csv,
    });
    expect(res.json()).toEqual({
      imported: 1,
      existing: 1,
      skipped: [
        { row: 3, reason: 'no consent' },
        { row: 4, reason: '"not-a-phone" is not a valid phone number' },
      ],
    });
  });
});
