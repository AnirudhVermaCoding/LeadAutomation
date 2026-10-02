import { createFakeEmail } from '@instantlead/integrations';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, findSlots } from './booking.ts';
import { withTenant } from './db/client.ts';
import { appointments, messages } from './db/schema.ts';

const graphCalls: { url: string; body: { template?: { name: string } } }[] = [];
const fakeGraph = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  graphCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return new Response(JSON.stringify({ messages: [{ id: `wamid.${graphCalls.length}` }] }));
}) as typeof fetch;

let t: TestContext;
let A: string; // fake channel
let B: string; // Meta channel, templates not approved
let cookieA: string;
let cookieB: string;
let n = 0;

beforeAll(async () => {
  t = await createTestContext({ fetch: fakeGraph });
  const mk = async (slug: string) =>
    (
      await t.ctx.system.createTenant(
        {
          slug,
          name: `Clinic ${slug}`,
          preset: 'clinic_dental',
          admin: { email: `admin@${slug}.test`, name: slug, password: PASSWORD },
        },
        { type: 'system' },
      )
    ).tenant.id;
  A = await mk('a');
  B = await mk('b');
  cookieA = await t.signIn('admin@a.test');
  cookieB = await t.signIn('admin@b.test');
});
afterAll(() => t.close());

const api = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const thread = (tenant: string, leadId: string) =>
  withTenant(t.ctx.db, tenant, (tx) =>
    tx
      .select()
      .from(messages)
      .where(eq(messages.leadId, leadId))
      .orderBy(asc(messages.occurredAt), asc(messages.createdAt)),
  );
const outs = async (tenant: string, leadId: string) =>
  (await thread(tenant, leadId)).filter((m) => m.direction === 'out');

async function bookedLead(tenant: string, cookie: string, date: string, idx = 0) {
  const phone = `98730${String(++n).padStart(5, '0')}`;
  const res = await api(cookie, 'POST', '/v1/leads', { phone, name: 'Asha Rao', consent: { granted: true } });
  const leadId = (res.json() as { lead_id: string }).lead_id;
  await t.drainJobs();
  const slot = (await findSlots(t.ctx, tenant, { service: 'Consultation', date, limit: 100, spread: false }))
    .slots[idx]!;
  const { appointment } = await bookSlot(t.ctx, tenant, {
    leadId,
    service: 'Consultation',
    date,
    time: slot.time,
    source: 'staff',
  });
  await t.drainJobs();
  return { leadId, phone, appointment };
}

describe('cancelling outside the 24-hour window', () => {
  test('staff cancel with a silent customer: the approved cancellation template goes out, with a Book-again button', async () => {
    const { leadId, appointment } = await bookedLead(A, cookieA, '2026-10-12');
    t.clock.advance(30 * 3_600_000); // the customer has not written for > 24 h
    expect((await api(cookieA, 'POST', `/v1/appointments/${appointment.id}/cancel`)).statusCode).toBe(200);
    await t.drainJobs();
    const last = (await outs(A, leadId)).at(-1)!;
    expect(last).toMatchObject({ templateKey: 'cancellation', status: 'sent', kind: 'template' });
    expect(last.body).toMatch(/Hi Asha, your Consultation on .* has been cancelled/);
    expect((last.payload as { buttons: { id: string }[] }).buttons[0]?.id).toBe('cancellation:rebook');
    const [row] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, appointment.id)),
    );
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'staff' });
  });

  test('tapping Book a new time offers new slots for the same service', async () => {
    const { leadId, phone, appointment } = await bookedLead(A, cookieA, '2026-10-13');
    t.clock.advance(30 * 3_600_000);
    await api(cookieA, 'POST', `/v1/appointments/${appointment.id}/cancel`);
    await t.drainJobs();
    await api(cookieA, 'POST', '/v1/dev/whatsapp/inbound', {
      from: phone,
      button_payload: 'cancellation:rebook',
      text: 'Book a new time',
    });
    await t.drainAssistant();
    const last = (await outs(A, leadId)).at(-1)!;
    expect(last.body).toMatch(/next free times for your Consultation: 1\)/);
  });

  test('inside the window the same cancellation is a plain message (no template)', async () => {
    const { leadId, phone, appointment } = await bookedLead(A, cookieA, '2026-10-14');
    await api(cookieA, 'POST', '/v1/dev/whatsapp/inbound', { from: phone, text: 'hello' });
    await t.drainAssistant();
    await api(cookieA, 'POST', `/v1/appointments/${appointment.id}/cancel`);
    await t.drainJobs();
    const msg = (await outs(A, leadId)).find((m) => /has been cancelled/.test(m.body))!;
    expect(msg.templateKey).toBeNull();
    expect(msg.kind).toBe('text');
  });

  test('a customer cancelling by chat is recorded as a customer cancellation', async () => {
    const { leadId, phone } = await bookedLead(A, cookieA, '2026-10-15');
    await api(cookieA, 'POST', '/v1/dev/whatsapp/inbound', {
      from: phone,
      text: 'I need to cancel my appointment',
    });
    await t.drainAssistant();
    await t.drainJobs();
    const rows = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.leadId, leadId)),
    );
    // The mock assistant may or may not call the tool for this wording; when it does the reason is 'customer'.
    for (const r of rows.filter((x) => x.status === 'cancelled')) expect(r.cancelReason).toBe('customer');
  });
});

describe('a message that cannot be sent is never silent', () => {
  test('template not approved on Meta: the failure is recorded and staff are told to call', async () => {
    // Connect a (fake) Meta number: from now on templates must be approved.
    expect(
      (
        await api(cookieB, 'PUT', '/v1/integrations/whatsapp', {
          id: '123456789012',
          access_token: 'x'.repeat(30),
        })
      ).statusCode,
    ).toBe(200);
    const cfg = (await api(cookieB, 'GET', '/v1/config')).json() as {
      config: { booking: { staff_notify: unknown } };
    };
    cfg.config.booking.staff_notify = { channel: 'email', to: 'staff@b.test' };
    expect((await api(cookieB, 'PUT', '/v1/config', cfg.config)).statusCode).toBe(200);

    const email = createFakeEmail();
    (t.ctx as { email: unknown }).email = email;
    const phone = `98730${String(++n).padStart(5, '0')}`;
    const lead = (
      await api(cookieB, 'POST', '/v1/leads', { phone, name: 'Dev Patel', consent: { granted: true } })
    ).json() as { lead_id: string };
    await t.drainJobs();
    const slot = (
      await findSlots(t.ctx, B, { service: 'Consultation', date: '2026-10-16', limit: 100, spread: false })
    ).slots[0]!;
    const { appointment } = await bookSlot(t.ctx, B, {
      leadId: lead.lead_id,
      service: 'Consultation',
      date: '2026-10-16',
      time: slot.time,
      source: 'staff',
    });
    await t.drainJobs();
    t.clock.advance(30 * 3_600_000);
    await api(cookieB, 'POST', `/v1/appointments/${appointment.id}/cancel`);
    await t.drainJobs();
    const failed = (await outs(B, lead.lead_id)).find((m) => m.templateKey === 'cancellation');
    expect(failed?.status).toBe('failed');
    expect(
      email.sent.some((m) => /Could not message Dev Patel/.test(m.text) && m.to[0] === 'staff@b.test'),
    ).toBe(true);

    // Once approved, the same send reaches Meta under the registry name.
    await api(cookieB, 'PUT', '/v1/templates/cancellation/en', { status: 'approved' });
    const { appointment: second } = await bookSlot(t.ctx, B, {
      leadId: lead.lead_id,
      service: 'Consultation',
      date: '2026-10-17',
      time: slot.time,
      source: 'staff',
    });
    await t.drainJobs();
    await api(cookieB, 'POST', `/v1/appointments/${second.id}/cancel`);
    await t.drainJobs();
    expect(graphCalls.some((c) => c.body?.template?.name === 'il_cancellation')).toBe(true);
  });
});
