import { HOUR } from '@instantlead/core';
import { createFakeEmail } from '@instantlead/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, findSlots, updateAppointment } from './booking.ts';
import { withTenant } from './db/client.ts';
import { reports } from './db/schema.ts';
import { runMonitor } from './monitoring.ts';
import { runScheduledReports } from './reports.ts';

let t: TestContext;
let A: string;
let cookie: string;

beforeAll(async () => {
  // Mon 5 Oct 2026 10:00 IST. Dental preset: weekly report on Monday, avg visit ₹4,000.
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

const post = (url: string, payload: object) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
const emails = () =>
  (t.ctx.email as unknown as { sent: { to: string[]; subject: string; text: string }[] }).sent;

describe('weekly report (demo scenario 4)', () => {
  test('a week of activity -> Monday report with numbers counted from the database, sent once', async () => {
    // Three form leads, each answered instantly by the first-reply job.
    const ids: string[] = [];
    for (const phone of ['9800011111', '9800022222', '9800033333']) {
      const res = await post('/v1/leads', { phone, name: 'Lead', consent: { granted: true } });
      ids.push((res.json() as { lead_id: string }).lead_id);
    }
    await t.drainJobs();
    // One replies with a price question.
    await post('/v1/dev/whatsapp/inbound', { from: '9800011111', text: 'How much is whitening?' });
    await t.drainAssistant();

    // Two bookings this week: one visit happens, one is a no-show.
    const [a, b] = (await findSlots(t.ctx, A, { service: 'Consultation', date: '2026-10-06', spread: false }))
      .slots;
    const first = await bookSlot(t.ctx, A, {
      leadId: ids[0]!,
      service: 'Consultation',
      date: a!.date,
      time: a!.time,
      source: 'staff',
    });
    const second = await bookSlot(t.ctx, A, {
      leadId: ids[1]!,
      service: 'Consultation',
      date: b!.date,
      time: '14:00',
      source: 'staff',
    });
    await t.drainJobs();
    t.clock.advance(30 * HOUR); // Tue 16:00 IST, both visits are over
    await updateAppointment(t.ctx, A, first.appointment.id, 'completed');
    await updateAppointment(t.ctx, A, second.appointment.id, 'no_show');
    await t.drainJobs();

    // Not report day yet.
    expect(await runScheduledReports(t.ctx)).toEqual([]);

    t.clock.set('2026-10-12T03:35:00Z'); // Mon 12 Oct 09:05 IST
    const before = emails().length;
    expect(await runScheduledReports(t.ctx)).toEqual([A]);
    expect(await runScheduledReports(t.ctx)).toEqual([]); // once per week

    const [report] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(reports).where(eq(reports.tenantId, A)),
    );
    expect(report?.data).toMatchObject({
      period: { label: '2026-10-05 to 2026-10-11' },
      leads: 3, // the price question came from a form lead's phone: deduped, not a new lead
      repliedLeads: 1,
      medianFirstResponseSec: 0,
      booked: 2,
      shows: 1,
      noShows: 1,
      showRate: 0.5,
      revenueRecoveredInr: 4000,
      topTopics: [{ topic: 'Prices', count: 1 }],
    });
    expect(report?.sentAt).not.toBeNull();
    const mail = emails().slice(before);
    expect(mail).toEqual([
      expect.objectContaining({
        to: ['owner@example.com'],
        subject: 'Smile Dental: your week in leads (2026-10-05 to 2026-10-11)',
        text: expect.stringMatching(/Estimated revenue from completed visits: ₹4,000/),
      }),
    ]);
  });

  test('preview uses the same numbers for any window', async () => {
    const res = await t.app.inject({
      url: '/v1/reports/preview?from=2026-10-04T18:30:00Z&to=2026-10-11T18:30:00Z',
      headers: { cookie },
    });
    expect(res.json()).toMatchObject({
      data: { booked: 2, shows: 1, noShows: 1 },
      email: { subject: expect.any(String) },
    });
    const list = await t.app.inject({ url: '/v1/reports', headers: { cookie } });
    expect((list.json() as unknown[]).length).toBe(1);
  });
});

describe('monitoring', () => {
  test('repeated failed sends raise one alert email, deduped while it persists', async () => {
    const [lead] = (
      await t.owner.query<{ id: string }>('select id from leads where tenant_id = $1 limit 1', [A])
    ).rows;
    for (let i = 0; i < 3; i++)
      await t.owner.query(
        `insert into messages (tenant_id, lead_id, direction, kind, body, status, occurred_at, error)
         values ($1, $2, 'out', 'text', 'x', 'failed', now(), '{"message":"boom"}')`,
        [A, lead!.id],
      );
    const email = createFakeEmail();
    const deps = { system: t.ctx.system, email, alertEmail: 'ops@agency.test', now: () => t.clock.now() };
    expect(await runMonitor(deps)).toEqual({ found: 1, emailed: 1 });
    expect(email.sent[0]).toMatchObject({
      to: ['ops@agency.test'],
      text: expect.stringMatching(/Smile Dental: 3 WhatsApp sends failed/),
    });
    expect(await runMonitor(deps)).toEqual({ found: 1, emailed: 0 });
  });

  test('tenant health panel and agency monitoring view', async () => {
    const health = (await t.app.inject({ url: '/v1/health', headers: { cookie } })).json();
    expect(health).toMatchObject({ failedSends24h: 3, lastSuccessfulSend: expect.any(String) });
    expect((await t.app.inject({ url: '/v1/admin/monitoring', headers: { cookie } })).statusCode).toBe(403);
  });
});
