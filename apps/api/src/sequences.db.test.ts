import { HOUR, localParts } from '@instantlead/core';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, findSlots, updateAppointment } from './booking.ts';
import { withTenant } from './db/client.ts';
import { appointments, enrollments, enrollmentSteps, leads, messages } from './db/schema.ts';
import { runStep, sweepDueSteps } from './sequences.ts';

let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

beforeAll(async () => {
  // Clock starts Mon 5 Oct 2026, 10:00 IST. Dental preset: follow-ups at 48 h and 120 h,
  // reminders 24 h and 2 h before, review 3 h after a visit, no-show recovery after 2 h.
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

const phoneOf = () => `98760${String(++n).padStart(5, '0')}`;
async function newLead(extra: object = {}) {
  const phone = phoneOf();
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/leads',
    headers: { cookie },
    payload: { phone, name: 'Priya Sharma', consent: { granted: true }, ...extra },
  });
  await t.drainJobs(); // first reply -> follow-ups enrolled
  return { leadId: (res.json() as { lead_id: string }).lead_id, phone };
}
const lead = async (id: string) =>
  (await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, id))))[0]!;
const outTemplates = async (id: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(messages)
        .where(eq(messages.leadId, id))
        .orderBy(asc(messages.occurredAt), asc(messages.createdAt)),
    )
  )
    .filter((m) => m.direction === 'out')
    .map((m) => m.templateKey ?? `text:${m.body}`);
const say = async (phone: string, payload: object) => {
  await t.app.inject({
    method: 'POST',
    url: '/v1/dev/whatsapp/inbound',
    headers: { cookie },
    payload: { from: phone, ...payload },
  });
  return t.drainAssistant();
};
async function book(leadId: string, daysAhead: number) {
  const date = localParts(new Date(t.clock.now().getTime() + daysAhead * 24 * HOUR), 'Asia/Kolkata').date;
  // From noon on, so the 2 h reminder never lands in morning quiet hours.
  const slot = (await findSlots(t.ctx, A, { service: 'Consultation', date, spread: false })).slots.find(
    (x) => x.time >= '12:00',
  );
  const r = await bookSlot(t.ctx, A, {
    leadId,
    service: 'Consultation',
    date: slot!.date,
    time: slot!.time,
    source: 'staff',
  });
  await t.drainJobs();
  return r.appointment;
}
const hoursUntil = (at: Date) => (at.getTime() - t.clock.now().getTime()) / HOUR;

describe('follow-ups for silent leads (demo scenario 2)', () => {
  test('day 0 first reply -> day 2 -> day 5 -> unresponsive', async () => {
    const { leadId } = await newLead();
    expect(await outTemplates(leadId)).toEqual(['first_reply']);

    await t.advance(47);
    expect(await outTemplates(leadId)).toEqual(['first_reply']);
    await t.advance(1);
    expect(await outTemplates(leadId)).toEqual(['first_reply', 'followup_day2']);
    await t.advance(72);
    expect(await outTemplates(leadId)).toEqual(['first_reply', 'followup_day2', 'followup_day5']);
    expect((await lead(leadId)).state).toBe('contacted');
    await t.advance(48);
    expect((await lead(leadId)).state).toBe('unresponsive');
  });

  test('a reply stops pending follow-ups', async () => {
    const { leadId, phone } = await newLead();
    await say(phone, { text: 'hi, whitening please' });
    await t.advance(130);
    expect((await outTemplates(leadId)).filter((k) => k.startsWith('followup'))).toEqual([]);
    const [e] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(enrollments).where(eq(enrollments.leadId, leadId)),
    );
    expect(e).toMatchObject({ kind: 'followup', status: 'stopped', stopReason: 'replied' });
  });

  test('day-2 follow-up goes by email when the lead gave one (email_or_whatsapp)', async () => {
    const before = (t.ctx.email as unknown as { sent: unknown[] }).sent.length;
    const { leadId } = await newLead({ email: 'priya@example.com' });
    await t.advance(48);
    const sent = (t.ctx.email as unknown as { sent: { to: string[]; text: string }[] }).sent.slice(before);
    expect(sent).toEqual([
      expect.objectContaining({
        to: ['priya@example.com'],
        text: expect.stringMatching(/Hi Priya, just checking in from Smile Dental/),
      }),
    ]);
    expect((await outTemplates(leadId)).includes('followup_day2')).toBe(false);
  });
});

describe('appointment reminders and after-visit messages', () => {
  test('24 h + 2 h reminders; Confirm button confirms and alerts staff; completion -> review request', async () => {
    const { leadId, phone } = await newLead();
    const appt = await book(leadId, 3);

    await t.advance(hoursUntil(appt.startsAt) - 24);
    expect((await outTemplates(leadId)).at(-1)).toBe('reminder_24h');

    const staffBefore = t.ctx.fakeChannel.sent.length;
    await say(phone, { button_payload: 'reminder_24h:confirm' });
    await t.drainJobs();
    expect((await lead(leadId)).state).toBe('confirmed');
    expect((await outTemplates(leadId)).at(-1)).toMatch(/^text:Thanks for confirming/);
    expect(t.ctx.fakeChannel.sent.slice(staffBefore).some((s) => s.to === '+910000000000')).toBe(true);

    await t.advance(22);
    expect((await outTemplates(leadId)).at(-1)).toBe('reminder_2h');

    await t.advance(2);
    await updateAppointment(t.ctx, A, appt.id, 'completed');
    await t.drainJobs();
    await t.advance(3);
    expect((await outTemplates(leadId)).at(-1)).toBe('review_request');
    const review = (
      await withTenant(t.ctx.db, A, (tx) => tx.select().from(messages).where(eq(messages.leadId, leadId)))
    ).find((m) => m.templateKey === 'review_request');
    expect(review?.body).toMatch(/g\.page\/r\//);
  });

  test('Cancel button cancels the appointment and the remaining reminder', async () => {
    const { leadId, phone } = await newLead();
    const appt = await book(leadId, 2);
    await t.advance(hoursUntil(appt.startsAt) - 24);
    await say(phone, { button_payload: 'reminder_24h:cancel' });
    await t.drainJobs();
    const [after] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, appt.id)),
    );
    expect(after?.status).toBe('cancelled');
    await t.advance(24);
    expect(await outTemplates(leadId)).not.toContain('reminder_2h');
  });

  test('no-show -> recovery message (demo scenario 3)', async () => {
    const { leadId } = await newLead();
    const appt = await book(leadId, 1);
    await t.advance(hoursUntil(appt.startsAt) + 0.5);
    await updateAppointment(t.ctx, A, appt.id, 'no_show');
    await t.drainJobs();
    await t.advance(2);
    expect((await outTemplates(leadId)).at(-1)).toBe('no_show_recovery');
    expect((await lead(leadId)).state).toBe('no_show');
  });

  test('opt-out stops every sequence', async () => {
    const { leadId, phone } = await newLead();
    await book(leadId, 3);
    await say(phone, { text: 'STOP' });
    const steps = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select({ status: enrollmentSteps.status })
        .from(enrollmentSteps)
        .innerJoin(enrollments, eq(enrollments.id, enrollmentSteps.enrollmentId))
        .where(eq(enrollments.leadId, leadId)),
    );
    expect(steps.every((s) => s.status === 'cancelled' || s.status === 'sent')).toBe(true);
    await t.advance(80);
    expect((await outTemplates(leadId)).filter((k) => k.startsWith('reminder'))).toEqual([]);
  });
});

describe('robustness', () => {
  test('a step job delivered twice sends once; sent steps are never claimed again', async () => {
    t.clock.set('2026-10-26T04:30:00Z'); // Mon 10:00 IST, outside quiet hours
    const { leadId } = await newLead();
    t.clock.advance(48 * HOUR);
    const claimed = await t.ctx.system.claimDueSteps(t.clock.now());
    const mine = claimed;
    const results = [];
    for (const c of mine) results.push(await runStep(t.ctx, c), await runStep(t.ctx, c));
    expect(results.filter((r) => r.status === 'ignored').length).toBeGreaterThanOrEqual(mine.length);
    expect((await outTemplates(leadId)).filter((k) => k === 'followup_day2')).toHaveLength(1);
    expect(await sweepDueSteps(t.ctx)).toBe(0);
  });

  test('the dev clock endpoint fast-forwards and sweeps (mock mode)', async () => {
    const before = t.clock.now().getTime();
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/dev/clock/advance',
      headers: { cookie },
      payload: { hours: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(new Date((res.json() as { now: string }).now).getTime() - before).toBe(HOUR);
  });

  test('quiet hours push a follow-up to the next morning', async () => {
    t.clock.set('2026-11-02T16:00:00Z'); // Mon 21:30 IST: quiet
    const { leadId } = await newLead();
    await t.advance(48); // Wed 21:30 IST: still quiet -> deferred
    expect(await outTemplates(leadId)).not.toContain('followup_day2');
    const [step] = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(enrollmentSteps)
        .innerJoin(enrollments, eq(enrollments.id, enrollmentSteps.enrollmentId))
        .where(eq(enrollments.leadId, leadId))
        .orderBy(asc(enrollmentSteps.step)),
    );
    expect(step?.enrollment_steps.dueAt.toISOString()).toBe('2026-11-05T03:30:00.000Z'); // Thu 09:00 IST
    await t.advance(11.5);
    expect(await outTemplates(leadId)).toContain('followup_day2');
  });
});
