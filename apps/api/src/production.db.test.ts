import type { TenantConfig } from '@instantlead/config';
import { ChannelError, createFakeCalendar, type CalendarProvider } from '@instantlead/integrations';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { bookSlot, findSlots } from './booking.ts';
import { getActiveConfig, saveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import {
  appointments,
  calls,
  events,
  leads,
  messages,
  opportunities,
  treatmentPlans,
  waitlistEntries,
} from './db/schema.ts';
import { notifyAppointmentChange } from './notify.ts';
import { actOnOpportunity, sweepOpportunities } from './opportunities.ts';
import { eraseLead, runRetention } from './privacy.ts';
import { joinWaitlist } from './waitlist.ts';

// Google is down for the first `failures` writes, then recovers.
const fake = createFakeCalendar();
let failures = 0;
const flaky: CalendarProvider = {
  ...fake,
  upsert: (...args) => {
    if (failures > 0) {
      failures--;
      return Promise.reject(new Error('Google 503'));
    }
    return fake.upsert(...args);
  },
};

let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

beforeAll(async () => {
  t = await createTestContext({ calendarFor: () => Promise.resolve(flaky) });
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

async function setConfig(change: (c: TenantConfig) => TenantConfig) {
  await withTenant(t.ctx.db, A, async (tx) => {
    const config = change(structuredClone((await getActiveConfig(tx))!.config));
    await saveConfig(tx, t.clock, { type: 'system' }, config);
  });
}
async function newLead(name = 'Priya') {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/leads',
    headers: { cookie },
    payload: { phone: `98777${String(++n).padStart(5, '0')}`, name, consent: { granted: true } },
  });
  await t.drainJobs();
  return (res.json() as { lead_id: string }).lead_id;
}
const sentTo = (to: string) =>
  (t.ctx.fakeChannel as unknown as { sent: { to: string }[] }).sent.filter((s) => s.to === to);

describe('a failed provider recovers safely', () => {
  test('Google down while a booking is notified: the job fails and retries; patient and staff are messaged once; the event lands after recovery', async () => {
    const leadId = await newLead('Ravi');
    const [slot] = (await findSlots(t.ctx, A, { service: 'Consultation', limit: 1, spread: false })).slots;
    const staffNumber = '+910000000000'; // preset staff_notify
    const before = sentTo(staffNumber).length;
    failures = 1;
    const { appointment } = await bookSlot(t.ctx, A, {
      leadId,
      service: 'Consultation',
      date: slot!.date,
      time: slot!.time,
      source: 'staff',
    });
    const job = { tenantId: A, appointmentId: appointment.id, kind: 'booked' as const };
    await expect(notifyAppointmentChange(t.ctx, job)).rejects.toThrow(/Google 503/); // the job retries
    await notifyAppointmentChange(t.ctx, job); // the retry, Google is back
    await t.drainJobs(); // the original queued job too: a third run
    const lead = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(messages)
        .where(eq(messages.idempotencyKey, `appt:${appointment.id}:booked`)),
    );
    expect(lead).toHaveLength(1);
    expect(sentTo(staffNumber).length - before).toBe(1);
    const [row] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, appointment.id)),
    );
    expect(row?.googleEventId).toBeTruthy();
    expect(fake.events.has(row!.googleEventId!)).toBe(true);
  });

  test('WhatsApp down for a recovery follow-up: the job throws to retry, then sends exactly once', async () => {
    const leadId = await newLead('Meera');
    await t.app.inject({
      method: 'POST',
      url: `/v1/leads/${leadId}/treatment-plans`,
      headers: { cookie },
      payload: { title: 'Braces adjustment', status: 'accepted' },
    });
    // Stop the sweep from acting by itself, so the job can be driven by hand.
    await setConfig((c) => ({ ...c, autonomy: { follow_up: 'approval' } }));
    t.clock.advance(8 * 86_400_000);
    await sweepOpportunities(t.ctx);
    const [o] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(opportunities).where(eq(opportunities.leadId, leadId)),
    );
    expect(o?.status).toBe('needs_approval');
    const channel = t.ctx.fakeChannel as { send: typeof t.ctx.fakeChannel.send };
    const real = channel.send;
    channel.send = () => Promise.reject(new ChannelError('Meta 503', { retryable: true }));
    await expect(
      actOnOpportunity(t.ctx, { tenantId: A, opportunityId: o!.id, approvedBy: 'staff' }),
    ).rejects.toThrow(/Meta 503/);
    channel.send = real;
    expect(await actOnOpportunity(t.ctx, { tenantId: A, opportunityId: o!.id, approvedBy: 'staff' })).toEqual(
      {
        status: 'sent',
      },
    );
    expect(
      (await actOnOpportunity(t.ctx, { tenantId: A, opportunityId: o!.id, approvedBy: 'staff' })).status,
    ).toBe('skipped'); // a duplicate job does nothing
    const sent = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(messages)
        .where(and(eq(messages.idempotencyKey, `opp:${o!.id}`), eq(messages.status, 'sent'))),
    );
    expect(sent).toHaveLength(1);
    await setConfig((c) => ({ ...c, autonomy: {} }));
  });
});

describe('privacy covers the new data', () => {
  test('anonymization removes call summaries, plan text and family names; erasure deletes every new row', async () => {
    const keep = await newLead('Keep');
    const gone = await newLead('Gone');
    for (const leadId of [keep, gone])
      await withTenant(t.ctx.db, A, async (tx) => {
        await tx
          .insert(treatmentPlans)
          .values({ leadId, title: 'Implant for Rhea', attendeeName: 'Rhea', status: 'declined' });
        await tx.insert(calls).values({
          leadId,
          provider: 'vapi',
          providerCallId: `c-${leadId}`,
          startedAt: t.clock.now(),
          summary: 'Caller Gone asked about implants',
        });
      });
    await joinWaitlist(t.ctx, A, { leadId: keep, service: 'Consultation', forName: 'Rhea', source: 'staff' });
    await joinWaitlist(t.ctx, A, { leadId: gone, service: 'Consultation', source: 'staff' });

    await withTenant(t.ctx.db, A, (tx) => eraseLead(tx, t.ctx, A, { type: 'system' }, gone));
    const left = await withTenant(t.ctx.db, A, async (tx) => ({
      calls: await tx.select().from(calls).where(eq(calls.leadId, gone)),
      plans: await tx.select().from(treatmentPlans).where(eq(treatmentPlans.leadId, gone)),
      waitlist: await tx.select().from(waitlistEntries).where(eq(waitlistEntries.leadId, gone)),
    }));
    expect(left).toEqual({ calls: [], plans: [], waitlist: [] });

    await setConfig((c) => ({ ...c, privacy: { retention_days: 30, mode: 'anonymize' } }));
    t.clock.advance(60 * 86_400_000);
    await runRetention(t.ctx);
    const after = await withTenant(t.ctx.db, A, async (tx) => ({
      lead: (await tx.select().from(leads).where(eq(leads.id, keep)))[0],
      call: (await tx.select().from(calls).where(eq(calls.leadId, keep)))[0],
      plan: (await tx.select().from(treatmentPlans).where(eq(treatmentPlans.leadId, keep)))[0],
      wait: (await tx.select().from(waitlistEntries).where(eq(waitlistEntries.leadId, keep)))[0],
    }));
    expect(after.lead?.phoneE164).toMatch(/^anonymized:/);
    expect(after.call?.summary).toBeNull();
    expect(after.plan).toMatchObject({ title: '[removed]', attendeeName: null });
    expect(after.wait?.attendeeName).toBeNull();
    await setConfig((c) => ({ ...c, privacy: { retention_days: 0, mode: 'anonymize' } }));
  });

  test('events carry the lead id for the timeline but never personal data', async () => {
    const rows = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select({ payload: events.payload })
        .from(events)
        .where(like(sql`${events.payload}::text`, '%Gone%')),
    );
    expect(rows).toEqual([]);
  });
});

describe('human takeover → hand-back', () => {
  test('while staff have taken over the assistant stays silent; after hand-back it answers again', async () => {
    const say = (text: string) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/dev/whatsapp/inbound',
        headers: { cookie },
        payload: { from: '9812312312', text },
      });
    await say('hi, do you do cleaning?');
    await t.drainAssistant();
    const [lead] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(leads).where(eq(leads.phoneE164, '+919812312312')),
    );
    const outCount = async () =>
      (
        await withTenant(t.ctx.db, A, (tx) =>
          tx
            .select()
            .from(messages)
            .where(and(eq(messages.leadId, lead!.id), eq(messages.direction, 'out'))),
        )
      ).length;
    const before = await outCount();
    expect(before).toBeGreaterThan(0);
    await t.app.inject({ method: 'POST', url: `/v1/leads/${lead!.id}/takeover`, headers: { cookie } });
    await say('what are your timings?');
    await t.drainAssistant();
    expect(await outCount()).toBe(before);
    await t.app.inject({ method: 'POST', url: `/v1/leads/${lead!.id}/resume`, headers: { cookie } });
    await say('and do you open on sunday?');
    await t.drainAssistant();
    expect(await outCount()).toBe(before + 1);
  });
});
