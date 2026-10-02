import { MINUTE } from '@instantlead/core';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, updateAppointment } from './booking.ts';
import { getActiveConfig, saveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { appointments, enrollments, enrollmentSteps, messages } from './db/schema.ts';
import { computeReport } from './reports.ts';
import { runStaffDigest } from './staff-digest.ts';

// Dental preset: staff-confirm bookings, open Mon–Sat 10:00–20:00 and Sun 10:00–14:00 (IST),
// staff alerts on WhatsApp to +910000000000. Each test sets its own clock.
let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

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
beforeEach(async () => {
  await t.drainJobs();
});

const STAFF = '+910000000000';
async function newLead() {
  const phone = `98761${String(++n).padStart(5, '0')}`;
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/leads',
    headers: { cookie },
    payload: { phone, name: 'Priya Sharma', consent: { granted: true } },
  });
  await t.drainJobs();
  return { leadId: (res.json() as { lead_id: string }).lead_id, phone };
}
/** Book `date time` (IST) for a new lead; the assistant books as `pending` in staff-confirm mode. */
async function book(date: string, time: string, source: 'assistant' | 'staff' = 'assistant') {
  const { leadId, phone } = await newLead();
  const r = await bookSlot(t.ctx, A, { leadId, service: 'Consultation', date, time, source });
  await t.drainJobs();
  return { leadId, phone, appt: r.appointment };
}
/** Staff notes sent since `from` (the text of the staff_update template). */
const staffNotes = (from: number) =>
  t.ctx.fakeChannel.sent
    .slice(from)
    .filter((s) => s.to === STAFF && s.content.kind === 'template')
    .map((s) => (s.content.kind === 'template' ? (s.content.bodyParams ?? []).join(' ') : ''));
const status = async (id: string) =>
  (await withTenant(t.ctx.db, A, (tx) => tx.select().from(appointments).where(eq(appointments.id, id))))[0]!
    .status;
const leadTemplates = async (leadId: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(messages).where(eq(messages.leadId, leadId)).orderBy(asc(messages.occurredAt)),
    )
  )
    .filter((m) => m.direction === 'out')
    .map((m) => m.templateKey);
const watchSteps = async (leadId: string, kind: string) =>
  withTenant(t.ctx.db, A, async (tx) => {
    const [e] = await tx.select().from(enrollments).where(eq(enrollments.leadId, leadId));
    const all = await tx
      .select()
      .from(enrollmentSteps)
      .innerJoin(enrollments, eq(enrollments.id, enrollmentSteps.enrollmentId))
      .where(eq(enrollments.leadId, leadId))
      .orderBy(asc(enrollmentSteps.dueAt));
    return e ? all.filter((r) => r.enrollments.kind === kind).map((r) => r.enrollment_steps) : [];
  });

describe('pending bookings: nudge staff, then auto-confirm', () => {
  test('nudges at +30 min and +2 h, then auto-confirms the evening before; the patient gets confirmation + reminders', async () => {
    t.clock.set('2026-10-05T04:30:00Z'); // Mon 10:00 IST
    const { leadId, appt } = await book('2026-10-07', '15:00'); // Wed
    expect(appt.status).toBe('pending');
    expect(await leadTemplates(leadId)).toContain('booking_pending');
    const steps = await watchSteps(leadId, 'pending_watch');
    expect(steps.map((s) => [s.action, s.dueAt.toISOString()])).toEqual([
      ['nudge_pending', '2026-10-05T05:00:00.000Z'], // Mon 10:30
      ['nudge_pending', '2026-10-05T06:30:00.000Z'], // Mon 12:00
      ['auto_confirm', '2026-10-06T14:25:00.000Z'], // Tue 19:55, last open moment before Wed
    ]);

    let mark = t.ctx.fakeChannel.sent.length;
    await t.advance(0.5);
    expect(staffNotes(mark)).toEqual([
      expect.stringMatching(/booking for Consultation .* is waiting for your confirmation/),
    ]);
    mark = t.ctx.fakeChannel.sent.length;
    await t.advance(1.5);
    expect(staffNotes(mark)).toHaveLength(1);

    mark = t.ctx.fakeChannel.sent.length;
    await t.advance(32); // Tue 20:00
    await t.drainJobs();
    expect(await status(appt.id)).toBe('scheduled');
    expect(staffNotes(mark).join('\n')).toMatch(/confirmed automatically/);
    expect(await leadTemplates(leadId)).toContain('booking_confirmed');
    expect((await watchSteps(leadId, 'reminders')).map((s) => s.templateKey)).toEqual(['reminder_2h']); // 24 h already past
  });

  test('staff confirming first stops the watch: no nudges, no auto-confirm', async () => {
    t.clock.set('2026-10-05T04:30:00Z');
    const { leadId, appt } = await book('2026-10-08', '15:00');
    await updateAppointment(t.ctx, A, appt.id, 'confirmed');
    await t.drainJobs();
    const mark = t.ctx.fakeChannel.sent.length;
    await t.advance(30);
    expect(staffNotes(mark).filter((x) => /waiting for your confirmation|automatically/.test(x))).toEqual([]);
    expect((await watchSteps(leadId, 'pending_watch')).every((s) => s.status === 'cancelled')).toBe(true);
  });

  test('booked at night: the first nudge waits for opening time', async () => {
    t.clock.set('2026-10-05T16:30:00Z'); // Mon 22:00 IST
    const { leadId } = await book('2026-10-08', '16:00');
    const [first] = await watchSteps(leadId, 'pending_watch');
    expect(first?.dueAt.toISOString()).toBe('2026-10-06T05:00:00.000Z'); // Tue 10:30
  });

  test('short notice: staff told at once, auto-confirm after 20 minutes', async () => {
    t.clock.set('2026-10-09T05:30:00Z'); // Fri 11:00 IST
    const { leadId, appt } = await book('2026-10-09', '13:00');
    const steps = await watchSteps(leadId, 'pending_watch');
    expect(steps.map((s) => s.action)).toEqual(['nudge_pending', 'auto_confirm']);
    expect(steps[1]!.dueAt.getTime() - t.clock.now().getTime()).toBe(20 * MINUTE);
    await t.advance(20 / 60);
    await t.drainJobs();
    expect(await status(appt.id)).toBe('scheduled');
  });

  test('auto-confirm can be switched off: nudges only', async () => {
    await withTenant(t.ctx.db, A, async (tx) => {
      const config = (await getActiveConfig(tx))!.config;
      await saveConfig(
        tx,
        t.clock,
        { type: 'system' },
        { ...config, booking: { ...config.booking, auto_confirm_pending: false } },
      );
    });
    t.clock.set('2026-10-12T04:30:00Z'); // Mon 10:00
    const { leadId } = await book('2026-10-14', '15:00');
    expect((await watchSteps(leadId, 'pending_watch')).map((s) => s.action)).toEqual([
      'nudge_pending',
      'nudge_pending',
    ]);
    await withTenant(t.ctx.db, A, async (tx) => {
      const config = (await getActiveConfig(tx))!.config;
      await saveConfig(
        tx,
        t.clock,
        { type: 'system' },
        { ...config, booking: { ...config.booking, auto_confirm_pending: true } },
      );
    });
  });
});

describe('reminders nobody answers, visits nobody marks', () => {
  test('24 h reminder not confirmed: staff are told ~4 h before; tapping Confirm prevents it', async () => {
    t.clock.set('2026-10-19T04:30:00Z'); // Mon 10:00
    const a = await book('2026-10-21', '15:00', 'staff'); // Wed, booked by staff = scheduled
    const b = await book('2026-10-21', '16:00', 'staff');
    expect((await watchSteps(a.leadId, 'confirm_watch')).map((s) => s.dueAt.toISOString())).toEqual([
      '2026-10-21T05:30:00.000Z', // Wed 11:00 IST
    ]);
    await t.advance(29); // Tue 15:00: 24 h reminders out
    await t.app.inject({
      method: 'POST',
      url: '/v1/dev/whatsapp/inbound',
      headers: { cookie },
      payload: { from: b.phone, button_payload: 'reminder_24h:confirm' },
    });
    await t.drainAssistant();
    await t.drainJobs();
    const mark = t.ctx.fakeChannel.sent.length;
    await t.advance(20); // Wed 11:00
    const notes = staffNotes(mark).filter((x) => /has not confirmed/.test(x));
    expect(notes).toHaveLength(1); // only the one who didn't confirm
    expect(await status(b.appt.id)).toBe('confirmed');
  });

  test('end-of-day digest lists unmarked visits once; the report counts them', async () => {
    t.clock.set('2026-10-26T04:30:00Z'); // Mon 10:00
    const { appt } = await book('2026-10-26', '12:00', 'staff');
    t.clock.set('2026-10-26T14:40:00Z'); // Mon 20:10, just after closing
    const mark = t.ctx.fakeChannel.sent.length;
    expect(await runStaffDigest(t.ctx)).toEqual([A]);
    // Earlier tests' visits this week are unmarked too, so they're listed as well.
    expect(staffNotes(mark).join('\n')).toMatch(
      /visits? (is|are) not marked yet \(.*Priya Mon, 26 Oct, 12:00 pm/,
    );
    expect(await runStaffDigest(t.ctx)).toEqual([]); // once per evening
    const config = await withTenant(t.ctx.db, A, async (tx) => (await getActiveConfig(tx))!.config);
    const report = await withTenant(t.ctx.db, A, (tx) =>
      computeReport(
        tx,
        config,
        new Date('2026-10-25T18:30:00Z'),
        new Date('2026-10-26T18:30:00Z'),
        t.clock.now(),
      ),
    );
    expect(report.unmarkedVisits).toBe(1);
    await updateAppointment(t.ctx, A, appt.id, 'completed');
    // Next morning: still a reminder for the other unmarked visits, but not the one just marked.
    t.clock.set('2026-10-27T05:10:00Z'); // Tue 10:40
    const morning = t.ctx.fakeChannel.sent.length;
    await runStaffDigest(t.ctx);
    expect(staffNotes(morning).join(' | ')).not.toMatch(/26 Oct, 12:00 pm/);
  });
});
