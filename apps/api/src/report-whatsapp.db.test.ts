import { ChannelError, createFakeEmail, type EmailProvider } from '@instantlead/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { withTenant } from './db/client.ts';
import { reports } from './db/schema.ts';
import { runMonitor } from './monitoring.ts';
import { runScheduledReports } from './reports.ts';

let t: TestContext;
let A: string;
let cookie: string;

beforeAll(async () => {
  t = await createTestContext();
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
});
afterAll(() => t.close());

test('the weekly report also goes to WhatsApp; a failed email is retried without sending WhatsApp twice', async () => {
  const cfg = (
    (await t.app.inject({ url: '/v1/config', headers: { cookie } })).json() as {
      config: { reports: { send_to: string[]; whatsapp_to?: string[] } };
    }
  ).config;
  cfg.reports.send_to = ['owner@clinic.test'];
  cfg.reports.whatsapp_to = ['+919800011122'];
  expect(
    (await t.app.inject({ method: 'PUT', url: '/v1/config', headers: { cookie }, payload: cfg })).statusCode,
  ).toBe(200);

  const broken: EmailProvider = {
    provider: 'fake',
    send: () => Promise.reject(new ChannelError('Resend is down', { retryable: true })),
  };
  const working = createFakeEmail();
  const ctx = t.ctx as unknown as { email: EmailProvider };
  ctx.email = broken;
  await runScheduledReports(t.ctx); // Monday 10:00 IST: this tenant's report day
  const waTo = () => t.ctx.fakeChannel.sent.filter((s) => s.to === '+919800011122');
  expect(waTo()).toHaveLength(1);
  expect(waTo()[0]!.content).toMatchObject({ kind: 'template', name: 'il_report_weekly' });
  expect(JSON.stringify(waTo()[0]!.content)).toMatch(/enquiries, .* replied, .* booked/);
  const [row] = await withTenant(t.ctx.db, A, (tx) =>
    tx.select().from(reports).where(eq(reports.tenantId, A)),
  );
  expect(row).toMatchObject({ sentAt: null, error: expect.stringMatching(/email: Resend is down/) });

  ctx.email = working;
  t.clock.advance(3_600_000);
  await runScheduledReports(t.ctx); // the retry
  expect(working.sent).toHaveLength(1);
  expect(waTo()).toHaveLength(1); // not again
  const [after] = await withTenant(t.ctx.db, A, (tx) =>
    tx.select().from(reports).where(eq(reports.tenantId, A)),
  );
  expect(after).toMatchObject({ error: null });
  expect(after!.sentAt).not.toBeNull();
});

test('agency alerts also go to the agency WhatsApp when configured (and a failure there never breaks the monitor)', async () => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/leads',
    headers: { cookie },
    payload: { phone: '9890000001', consent: { granted: true } },
  });
  const leadId = (res.json() as { lead_id: string }).lead_id;
  for (let i = 0; i < 3; i++)
    await t.owner.query(
      `insert into messages (tenant_id, lead_id, direction, kind, body, status, occurred_at, error) values ($1,$2,'out','text','x','failed',now(),'{"message":"boom"}')`,
      [A, leadId],
    );
  const sent: string[] = [];
  const email = createFakeEmail();
  const r = await runMonitor({
    system: t.ctx.system,
    email,
    alertEmail: 'ops@agency.test',
    now: () => t.clock.now(),
    whatsapp: (note) => {
      sent.push(note);
      return Promise.reject(new Error('Meta down'));
    },
  });
  expect(r.emailed).toBeGreaterThan(0);
  expect(sent[0]).toMatch(/WhatsApp sends failed/);
  expect(email.sent).toHaveLength(1);
});
