import { createFakeCalendar } from '@instantlead/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, findSlots, updateAppointment } from './booking.ts';
import { withTenant } from './db/client.ts';
import { appointments, leads } from './db/schema.ts';
import { notifyAppointmentChange } from './notify.ts';

const calendar = createFakeCalendar();
let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

beforeAll(async () => {
  t = await createTestContext({ calendarFor: () => Promise.resolve(calendar) });
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

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function booked(name: string, date: string, idx: number) {
  const phone = `98710${String(++n).padStart(5, '0')}`;
  const res = await api('POST', '/v1/leads', { phone, name, consent: { granted: true } });
  const leadId = (res.json() as { lead_id: string }).lead_id;
  const slots = (await findSlots(t.ctx, A, { service: 'Consultation', date, limit: 200, spread: false }))
    .slots;
  const slot = slots[idx]!;
  const { appointment } = await bookSlot(t.ctx, A, {
    leadId,
    service: 'Consultation',
    date: slot.date,
    time: slot.time,
    source: 'staff',
  });
  await t.drainJobs();
  const eventId = (
    await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, appointment.id)),
    )
  )[0]!.googleEventId!;
  return { leadId, appointment, eventId };
}

describe('outbound calendar sync', () => {
  test('events carry our appointment id so they are never read back as busy', async () => {
    const { appointment, eventId } = await booked('Meera', '2026-10-13', 0);
    expect(
      calendar.google.live().find((e) => e.id === eventId)?.extendedProperties?.private?.instantlead_appt,
    ).toBe(appointment.id);
  });

  test('a completed visit stays on the calendar, marked; the id is kept', async () => {
    const { appointment, eventId } = await booked('Nikhil', '2026-10-13', 4);
    await updateAppointment(t.ctx, A, appointment.id, 'completed');
    await t.drainJobs();
    expect(calendar.events.get(eventId)?.summary).toBe('Done — Consultation — Nikhil');
  });

  test('a cancelled booking is removed and its event id cleared', async () => {
    const { appointment, eventId } = await booked('Om', '2026-10-13', 8);
    await updateAppointment(t.ctx, A, appointment.id, 'cancelled');
    await t.drainJobs();
    expect(calendar.events.has(eventId)).toBe(false);
    const [row] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, appointment.id)),
    );
    expect(row?.googleEventId).toBeNull();
  });

  test('replaying the notify job does not duplicate the event', async () => {
    const { appointment, eventId } = await booked('Pia', '2026-10-14', 0);
    const before = calendar.google.live().length;
    await notifyAppointmentChange(t.ctx, {
      tenantId: A,
      appointmentId: appointment.id,
      kind: 'calendar_sync',
    });
    await notifyAppointmentChange(t.ctx, {
      tenantId: A,
      appointmentId: appointment.id,
      kind: 'calendar_sync',
    });
    expect(calendar.google.live().length).toBe(before);
    expect(calendar.events.has(eventId)).toBe(true);
  });

  test('erasing a lead removes their event from Google (name and phone must not linger)', async () => {
    const { leadId, eventId } = await booked('Quincy', '2026-10-14', 4);
    expect(calendar.events.has(eventId)).toBe(true);
    expect((await api('DELETE', `/v1/leads/${leadId}`)).json()).toEqual({ erased: true });
    await t.drainJobs();
    expect(calendar.events.has(eventId)).toBe(false);
    expect(
      await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId))),
    ).toHaveLength(0);
  });
});
