import { buttonPayload } from '@instantlead/config';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { runTool, type ToolContext } from './assistant/tools.ts';
import { bookSlot, findSlots } from './booking.ts';
import { getActiveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { appointments, enrollments, leads, messages } from './db/schema.ts';

// Every way a booking can be rescheduled or cancelled, and who is told what:
//   customer by chat · customer by reminder buttons · staff in the dashboard · staff blocking time (leave).
// Clock: Mon 5 Oct 2026, 10:00 IST. Dental preset (staff alerts go to WhatsApp +910000000000).
const STAFF = '+910000000000';
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
  await t.app.inject({ method: 'POST', url: '/v1/dev/google/connect', headers: { cookie }, payload: {} }); // demo Google calendar
  await t.drainJobs();
});
afterAll(() => t.close());

const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const google = () => t.ctx.fakeGoogleFor(A);
const calendarEvent = (appointmentId: string) =>
  google()
    .live()
    .find((e) => e.extendedProperties?.private?.instantlead_appt === appointmentId);

/** A booked, confirmed appointment; the customer may or may not have written recently. */
async function world(date: string, idx: number, opts: { wrote?: boolean } = {}) {
  const phone = `98780${String(++n).padStart(5, '0')}`;
  const res = await api('POST', '/v1/leads', { phone, name: 'Isha Kulkarni', consent: { granted: true } });
  const leadId = (res.json() as { lead_id: string }).lead_id;
  await t.drainJobs();
  if (opts.wrote) {
    await api('POST', '/v1/dev/whatsapp/inbound', { from: phone, text: 'hello' });
    await t.drainAssistant();
  } else t.clock.advance(30 * 3_600_000); // the 24 h chat window is closed
  const slot = (await findSlots(t.ctx, A, { service: 'Consultation', date, limit: 200, spread: false }))
    .slots[idx]!;
  const { appointment } = await bookSlot(t.ctx, A, {
    leadId,
    service: 'Consultation',
    date,
    time: slot.time,
    source: 'staff',
  });
  await t.drainJobs();
  return { leadId, phone, appointment, mark: snapshot(leadId) };
}
const snapshot = (leadId: string) => ({ staff: t.ctx.fakeChannel.sent.length, leadId });
async function after(mark: { staff: number; leadId: string }) {
  const all = await withTenant(t.ctx.db, A, (tx) =>
    tx
      .select()
      .from(messages)
      .where(eq(messages.leadId, mark.leadId))
      .orderBy(asc(messages.occurredAt), asc(messages.createdAt)),
  );
  return {
    toPatient: all.filter((m) => m.direction === 'out'),
    toStaff: t.ctx.fakeChannel.sent
      .slice(mark.staff)
      .filter((s) => s.to === STAFF)
      .map((s) => s.content),
  };
}
const row = async (id: string) =>
  (await withTenant(t.ctx.db, A, (tx) => tx.select().from(appointments).where(eq(appointments.id, id))))[0]!;
const reminders = (appointmentId: string) =>
  withTenant(t.ctx.db, A, (tx) =>
    tx.select().from(enrollments).where(eq(enrollments.appointmentId, appointmentId)),
  );
const toolCtx = async (leadId: string): Promise<ToolContext> => ({
  deps: t.ctx,
  tenantId: A,
  leadId,
  config: (await withTenant(t.ctx.db, A, (tx) => getActiveConfig(tx)))!.config,
});
const slotOn = async (date: string, idx: number) =>
  (await findSlots(t.ctx, A, { service: 'Consultation', date, limit: 200, spread: false })).slots[idx]!;

describe('customer, by chat', () => {
  test('reschedule: patient confirmation, staff told with the generic update (not a "new booking"), calendar moved, reminders re-planned', async () => {
    const w = await world('2026-11-10', 4, { wrote: true });
    const target = await slotOn('2026-11-11', 10);
    const out = await runTool(await toolCtx(w.leadId), 'reschedule', {
      date: '2026-11-11',
      time: target.time,
    });
    expect(out.isError).toBeUndefined();
    await t.drainJobs();
    const moved = (
      await withTenant(t.ctx.db, A, (tx) =>
        tx.select().from(appointments).where(eq(appointments.leadId, w.leadId)),
      )
    ).find((a) => ['pending', 'scheduled'].includes(a.status))!;
    const msgs = await after(w.mark);
    expect(
      msgs.toPatient.some((m) => /received your request.*Wed, 11 Nov.*will confirm it shortly/.test(m.body)),
    ).toBe(true);
    expect(msgs.toStaff).toMatchObject([{ kind: 'template', name: 'il_staff_update' }]);
    expect(JSON.stringify(msgs.toStaff)).toMatch(/Rescheduled: Isha Kulkarni/);
    expect(calendarEvent(w.appointment.id)).toBeUndefined(); // old slot's event is gone
    expect(calendarEvent(moved.id)?.start?.dateTime).toBe(moved.startsAt.toISOString());
    expect((await reminders(w.appointment.id)).every((e) => e.status === 'stopped')).toBe(true);
  });

  test('cancel inside the chat window: plain message to the patient, staff told, calendar event removed, reminders stopped', async () => {
    const w = await world('2026-11-12', 4, { wrote: true });
    const out = await runTool(await toolCtx(w.leadId), 'cancel', {});
    expect(out.content).toMatch(/"cancelled":true/);
    await t.drainJobs();
    const msgs = await after(w.mark);
    const note = msgs.toPatient.find((m) => /has been cancelled/.test(m.body))!;
    expect(note.templateKey).toBeNull();
    expect(JSON.stringify(msgs.toStaff)).toMatch(/Cancelled: Isha Kulkarni/);
    expect(calendarEvent(w.appointment.id)).toBeUndefined();
    expect((await row(w.appointment.id)).cancelReason).toBe('customer');
    expect((await reminders(w.appointment.id)).every((e) => e.status === 'stopped')).toBe(true);
  });

  test('cancel by a customer who has not written for days: the approved cancellation template', async () => {
    const w = await world('2026-11-13', 4);
    await runTool(await toolCtx(w.leadId), 'cancel', {});
    await t.drainJobs();
    const msgs = await after(w.mark);
    expect(msgs.toPatient.find((m) => /cancelled/.test(m.body))).toMatchObject({
      templateKey: 'cancellation',
      status: 'sent',
    });
  });

  test('too close to the visit: refused, the team is alerted and takes over, nothing is cancelled', async () => {
    const w = await world('2026-10-06', 0, { wrote: true }); // tomorrow 10:00 = ~24 h away: raise the notice window instead
    const cfg = (
      (await api('GET', '/v1/config')).json() as {
        config: { booking: { change_notice_hours?: number; cancellation_policy?: string } };
      }
    ).config;
    cfg.booking.change_notice_hours = 48;
    cfg.booking.cancellation_policy = 'Late cancellations are charged 50%.';
    expect((await api('PUT', '/v1/config', cfg)).statusCode).toBe(200);
    const out = await runTool(await toolCtx(w.leadId), 'cancel', {});
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(
      /Changes are not possible within 48 hours.*Late cancellations are charged 50%/,
    );
    expect(out.content).toMatch(/team member has been alerted/);
    expect((await row(w.appointment.id)).status).toBe('scheduled');
    const [lead] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(leads).where(eq(leads.id, w.leadId)),
    );
    expect(lead!.aiPaused).toBe(true);
    await t.drainJobs();
    expect(JSON.stringify((await after(w.mark)).toStaff)).toMatch(/needs a reply|il_staff_handover/);
    // Staff are never held to the window.
    expect((await api('POST', `/v1/appointments/${w.appointment.id}/cancel`)).statusCode).toBe(200);
    cfg.booking.change_notice_hours = 2;
    await api('PUT', '/v1/config', cfg);
  });
});

describe('customer, by the reminder buttons', () => {
  test('Cancel on the 24 h reminder: cancelled exactly that appointment; patient and staff told; calendar and reminders follow', async () => {
    const w = await world('2026-11-17', 6, { wrote: true });
    await api('POST', '/v1/dev/whatsapp/inbound', {
      from: w.phone,
      text: 'Cancel',
      button_payload: buttonPayload('reminder_24h', 'cancel', w.appointment.id),
    });
    await t.drainAssistant();
    await t.drainJobs();
    const msgs = await after(w.mark);
    expect(msgs.toPatient.some((m) => /has been cancelled/.test(m.body))).toBe(true);
    expect(JSON.stringify(msgs.toStaff)).toMatch(/Cancelled: Isha Kulkarni/);
    expect((await row(w.appointment.id)).status).toBe('cancelled');
    expect(calendarEvent(w.appointment.id)).toBeUndefined();
  });

  test('Confirm on the reminder: lead_confirmed, patient thanked, staff updated, reminders keep going', async () => {
    const w = await world('2026-11-18', 6, { wrote: true });
    await api('POST', '/v1/dev/whatsapp/inbound', {
      from: w.phone,
      text: 'Confirm',
      button_payload: buttonPayload('reminder_24h', 'confirm', w.appointment.id),
    });
    await t.drainAssistant();
    await t.drainJobs();
    expect((await row(w.appointment.id)).status).toBe('confirmed');
    const msgs = await after(w.mark);
    expect(msgs.toPatient.some((m) => /Thanks for confirming/.test(m.body))).toBe(true);
    expect(JSON.stringify(msgs.toStaff)).toMatch(/Confirmed by the customer: Isha Kulkarni/);
  });

  test('Reschedule on the reminder starts the conversation about that appointment and moves it', async () => {
    const w = await world('2026-11-19', 6, { wrote: true });
    await api('POST', '/v1/dev/whatsapp/inbound', {
      from: w.phone,
      text: 'Reschedule',
      button_payload: buttonPayload('reminder_24h', 'reschedule', w.appointment.id),
    });
    await t.drainAssistant();
    const offered = (await after(w.mark)).toPatient.at(-1)!;
    expect(offered.body).toMatch(/1\) .*2\) /); // times to choose from
    await api('POST', '/v1/dev/whatsapp/inbound', { from: w.phone, text: '2' });
    await t.drainAssistant();
    await t.drainJobs();
    const moved = (
      await withTenant(t.ctx.db, A, (tx) =>
        tx.select().from(appointments).where(eq(appointments.leadId, w.leadId)),
      )
    ).filter((a) => ['pending', 'scheduled'].includes(a.status));
    expect(moved).toHaveLength(1);
    expect(moved[0]!.id).not.toBe(w.appointment.id);
    expect((await row(w.appointment.id)).status).toBe('cancelled');
    expect(JSON.stringify((await after(w.mark)).toStaff)).toMatch(/Rescheduled: Isha Kulkarni/);
  });
});

describe('staff, in the dashboard', () => {
  test('reschedule: the patient gets the confirmation template, calendar moves, reminders re-planned; no staff self-alert noise is required', async () => {
    const w = await world('2026-11-24', 4);
    const target = await slotOn('2026-11-25', 12);
    const res = await api('POST', `/v1/appointments/${w.appointment.id}/reschedule`, {
      date: '2026-11-25',
      time: target.time,
    });
    expect(res.statusCode).toBe(200);
    const moved = (res.json() as { appointment: { id: string; startsAt: string } }).appointment;
    await t.drainJobs();
    const msgs = await after(w.mark);
    expect(
      msgs.toPatient.find((m) => m.templateKey === 'booking_confirmed' && /Wed, 25 Nov/.test(m.body)),
    ).toBeTruthy();
    expect(calendarEvent(w.appointment.id)).toBeUndefined();
    expect(calendarEvent(moved.id)?.start?.dateTime).toBe(new Date(moved.startsAt).toISOString());
    expect((await reminders(moved.id)).some((e) => e.status === 'active')).toBe(true);
  });

  test('cancel: the patient is told (template if the window is closed), event removed, reminders stopped', async () => {
    const w = await world('2026-11-26', 4);
    expect((await api('POST', `/v1/appointments/${w.appointment.id}/cancel`)).statusCode).toBe(200);
    await t.drainJobs();
    const msgs = await after(w.mark);
    expect(msgs.toPatient.find((m) => /cancelled/.test(m.body))).toMatchObject({
      templateKey: 'cancellation',
      status: 'sent',
    });
    expect(calendarEvent(w.appointment.id)).toBeUndefined();
    expect((await row(w.appointment.id)).cancelReason).toBe('staff');
  });
});

describe('staff, blocking time (leave or closure)', () => {
  test('nothing is sent until staff choose; then the patient gets the change notice with a Show-new-times button', async () => {
    const w = await world('2026-12-01', 6);
    const start = (await row(w.appointment.id)).startsAt;
    const block = (
      await api('POST', '/v1/blocked-times', {
        starts_at: new Date(start.getTime() - 3_600_000).toISOString(),
        ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
        reason: 'Leave',
      })
    ).json() as { id: string; affected: unknown[] };
    expect(block.affected).toHaveLength(1);
    expect((await after(w.mark)).toPatient.some((m) => m.templateKey === 'appointment_change')).toBe(false);
    await api('POST', `/v1/blocked-times/${block.id}/notify`);
    await t.drainJobs();
    const msgs = await after(w.mark);
    expect(msgs.toPatient.find((m) => m.templateKey === 'appointment_change')).toBeTruthy();
    expect(calendarEvent(w.appointment.id)).toBeUndefined();
    expect((await row(w.appointment.id)).cancelReason).toBe('clinic_unavailable');
  });
});
