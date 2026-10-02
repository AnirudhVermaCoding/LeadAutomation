import { buttonPayload } from '@instantlead/config';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { runTool, type ToolContext } from './assistant/tools.ts';
import {
  BookingError,
  bookSlot,
  cancelLeadAppointment,
  findSlots,
  rescheduleLeadAppointment,
  updateAppointment,
} from './booking.ts';
import { getActiveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { appointments, enrollments, leads, messages } from './db/schema.ts';

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
  // Several visits per day; policy defaults (2 h notice) apply unless a test says otherwise.
});
afterAll(() => t.close());

const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const lead = async (name = 'Meena Shah') => {
  const phone = `98760${String(++n).padStart(5, '0')}`;
  const res = await api('POST', '/v1/leads', { phone, name, consent: { granted: true } });
  await t.drainJobs();
  return { leadId: (res.json() as { lead_id: string }).lead_id, phone };
};
const slots = async (date: string) =>
  (await findSlots(t.ctx, A, { service: 'Consultation', date, limit: 200, spread: false })).slots;
const book = async (leadId: string, date: string, idx: number, forName?: string | null) => {
  const slot = (await slots(date))[idx]!;
  return bookSlot(t.ctx, A, {
    leadId,
    service: 'Consultation',
    date,
    time: slot.time,
    source: 'staff',
    forName,
  });
};
const rows = (leadId: string) =>
  withTenant(t.ctx.db, A, (tx) =>
    tx.select().from(appointments).where(eq(appointments.leadId, leadId)).orderBy(asc(appointments.startsAt)),
  );
const stateOf = async (leadId: string) =>
  (await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, leadId))))[0]!.state;
const toolCtx = async (leadId: string): Promise<ToolContext> => ({
  deps: t.ctx,
  tenantId: A,
  leadId,
  config: (await withTenant(t.ctx.db, A, (tx) => getActiveConfig(tx)))!.config,
});

describe('one person, several bookings', () => {
  test('a parent books for themselves and a child from the same phone', async () => {
    const { leadId } = await lead();
    const mine = await book(leadId, '2026-10-12', 8);
    const kids = await book(leadId, '2026-10-12', 24, 'Rhea');
    expect(kids.appointment.attendeeName).toBe('Rhea');
    expect(mine.appointment.attendeeName).toBeNull();
    expect((await rows(leadId)).map((a) => a.status)).toEqual(['scheduled', 'scheduled']);
    expect(await stateOf(leadId)).toBe('booked');
    await t.drainJobs();
    const confirmations = (
      await withTenant(t.ctx.db, A, (tx) => tx.select().from(messages).where(eq(messages.leadId, leadId)))
    ).filter((m) => m.templateKey === 'booking_confirmed');
    expect(confirmations.map((m) => m.body).join('\n')).toMatch(/Consultation for Rhea/);
  });

  test('a second booking for the same person is refused (case-insensitive; their own name counts as themselves)', async () => {
    const { leadId } = await lead('Kavya Rao');
    await book(leadId, '2026-10-13', 4);
    await expect(book(leadId, '2026-10-13', 12)).rejects.toMatchObject({ code: 'already_booked' });
    await expect(book(leadId, '2026-10-13', 12, 'me')).rejects.toMatchObject({ code: 'already_booked' });
    await expect(book(leadId, '2026-10-13', 12, 'kavya')).rejects.toMatchObject({ code: 'already_booked' }); // their own first name
    await book(leadId, '2026-10-13', 20, 'Rhea');
    await expect(book(leadId, '2026-10-13', 28, 'rhea')).rejects.toMatchObject({ code: 'already_booked' });
  });

  test('two simultaneous bookings for one person: exactly one wins, the database says so', async () => {
    const { leadId } = await lead();
    const s = await slots('2026-10-14');
    const results = await Promise.allSettled([
      bookSlot(t.ctx, A, {
        leadId,
        service: 'Consultation',
        date: '2026-10-14',
        time: s[2]!.time,
        source: 'staff',
      }),
      bookSlot(t.ctx, A, {
        leadId,
        service: 'Consultation',
        date: '2026-10-14',
        time: s[14]!.time,
        source: 'staff',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as BookingError).code).toBe('already_booked');
    expect((await rows(leadId)).filter((a) => a.status === 'scheduled')).toHaveLength(1);
  });

  test('past, unmarked visits do not count as upcoming (a returning customer can book again)', async () => {
    const { leadId } = await lead();
    await book(leadId, '2026-10-12', 6);
    t.clock.advance(10 * 24 * 3_600_000); // the visit is long over and nobody marked it
    await book(leadId, '2026-10-20', 6);
    // The stale one is closed (staff can still mark it); the new one is live; reminders of the old one are gone.
    expect((await rows(leadId)).map((a) => a.status)).toEqual(['lapsed', 'scheduled']);
    const old = (await rows(leadId))[0]!;
    expect(
      (
        await withTenant(t.ctx.db, A, (tx) =>
          tx.select().from(enrollments).where(eq(enrollments.appointmentId, old.id)),
        )
      ).every((e) => e.status !== 'active'),
    ).toBe(true);
    await updateAppointment(t.ctx, A, old.id, 'completed'); // staff can still record what happened
  });
});

describe('choosing which appointment', () => {
  test('without a hint, several appointments are ambiguous and the error lists them; for_name picks one', async () => {
    const { leadId } = await lead();
    await book(leadId, '2026-10-21', 8);
    await book(leadId, '2026-10-21', 24, 'Rhea');
    await expect(cancelLeadAppointment(t.ctx, A, leadId)).rejects.toMatchObject({
      code: 'ambiguous',
      message: expect.stringMatching(/2 upcoming appointments.*for you.*for Rhea.*pass for_name/),
    });
    await cancelLeadAppointment(t.ctx, A, leadId, { forName: 'Rhea' });
    const [mine, rhea] = await rows(leadId);
    expect(mine!.status).toBe('scheduled');
    expect(rhea).toMatchObject({ status: 'cancelled', cancelReason: 'customer' });
    expect(await stateOf(leadId)).toBe('booked'); // they still have their own visit
    await cancelLeadAppointment(t.ctx, A, leadId); // only one left: no hint needed
    expect(await stateOf(leadId)).toBe('qualified');
  });

  test("rescheduling keeps the person: the child's visit moves, the parent's stays", async () => {
    const { leadId } = await lead();
    await book(leadId, '2026-10-22', 8);
    await book(leadId, '2026-10-22', 24, 'Rhea');
    const target = (await slots('2026-10-23'))[10]!;
    await rescheduleLeadAppointment(t.ctx, A, {
      leadId,
      date: '2026-10-23',
      time: target.time,
      source: 'staff',
      forName: 'Rhea',
    });
    const all = await rows(leadId);
    const active = all.filter((a) => a.status === 'scheduled');
    expect(active.map((a) => a.attendeeName).sort()).toEqual([null, 'Rhea'].sort());
    expect(active.find((a) => a.attendeeName === 'Rhea')!.startsAt.toISOString()).toBe(
      (
        await withTenant(t.ctx.db, A, (tx) =>
          tx
            .select()
            .from(appointments)
            .where(
              and(
                eq(appointments.leadId, leadId),
                eq(appointments.attendeeName, 'Rhea'),
                eq(appointments.status, 'scheduled'),
              ),
            ),
        )
      )[0]!.startsAt.toISOString(),
    );
    expect(all.filter((a) => a.status === 'cancelled')).toHaveLength(1);
  });

  test('the assistant tools: book_slot for_name, ambiguity is an error the model can act on', async () => {
    const { leadId } = await lead();
    const c = await toolCtx(leadId);
    const s = (await slots('2026-10-24'))[6]!;
    expect(
      (
        await runTool(c, 'book_slot', {
          service: 'Consultation',
          date: '2026-10-24',
          time: s.time,
          for_name: 'Rhea',
        })
      ).isError,
    ).toBeUndefined();
    const s2 = (await slots('2026-10-24'))[26]!;
    await runTool(c, 'book_slot', { service: 'Consultation', date: '2026-10-24', time: s2.time });
    const out = await runTool(c, 'cancel', {});
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Ask which one/);
    const ok = await runTool(c, 'cancel', { for_name: 'Rhea' });
    expect(ok.content).toMatch(/"cancelled":true/);
    expect(ok.content).toMatch(/do not repeat it/);
  });
});

describe('reminders and buttons follow the appointment', () => {
  test("reminders belong to their own appointment: cancelling one leaves the other's scheduled", async () => {
    const { leadId } = await lead();
    const a = await book(leadId, '2026-10-26', 8);
    const b = await book(leadId, '2026-10-26', 28, 'Rhea');
    const reminders = () =>
      withTenant(t.ctx.db, A, (tx) =>
        tx
          .select()
          .from(enrollments)
          .where(and(eq(enrollments.leadId, leadId), eq(enrollments.kind, 'reminders'))),
      );
    expect(
      (await reminders())
        .filter((e) => e.status === 'active')
        .map((e) => e.appointmentId)
        .sort(),
    ).toEqual([a.appointment.id, b.appointment.id].sort());
    await updateAppointment(t.ctx, A, b.appointment.id, 'cancelled', { cancelReason: 'staff' });
    const after = await reminders();
    expect(after.find((e) => e.appointmentId === b.appointment.id)?.status).toBe('stopped');
    expect(after.find((e) => e.appointmentId === a.appointment.id)?.status).toBe('active');
  });

  test("a reminder's buttons carry the appointment id, and the Cancel button cancels exactly that appointment", async () => {
    const { leadId, phone } = await lead();
    const a = await book(leadId, '2026-10-27', 8);
    const b = await book(leadId, '2026-10-27', 28, 'Rhea');
    // Jump to Oct 26 evening: the 24 h reminders for Oct 27 are due.
    await t.advance((new Date('2026-10-26T12:30:00Z').getTime() - t.clock.now().getTime()) / 3_600_000);
    const out = (
      await withTenant(t.ctx.db, A, (tx) => tx.select().from(messages).where(eq(messages.leadId, leadId)))
    ).filter((m) => m.templateKey === 'reminder_24h');
    expect(out).toHaveLength(2);
    const payloads = out.flatMap((m) =>
      (m.payload as { buttons: { id: string }[] }).buttons.map((x) => x.id),
    );
    expect(payloads).toContain(buttonPayload('reminder_24h', 'cancel', b.appointment.id));
    expect(payloads).toContain(buttonPayload('reminder_24h', 'confirm', a.appointment.id));

    await api('POST', '/v1/dev/whatsapp/inbound', {
      from: phone,
      text: 'Cancel',
      button_payload: buttonPayload('reminder_24h', 'cancel', b.appointment.id),
    });
    await t.drainAssistant();
    await t.drainJobs();
    const [mine, rhea] = await rows(leadId);
    expect(rhea).toMatchObject({ status: 'cancelled', attendeeName: 'Rhea' });
    expect(mine!.status).toBe('scheduled');
  });

  test('a plain Cancel button (an old message, no appointment id) with several bookings does not guess: it is not cancelled', async () => {
    const { leadId, phone } = await lead();
    await book(leadId, '2026-11-03', 8);
    await book(leadId, '2026-11-03', 28, 'Rhea');
    await api('POST', '/v1/dev/whatsapp/inbound', {
      from: phone,
      text: 'Cancel',
      button_payload: 'reminder_24h:cancel',
    });
    await t.drainAssistant();
    await t.drainJobs();
    expect((await rows(leadId)).filter((a) => a.status === 'cancelled')).toHaveLength(0);
  });
});
