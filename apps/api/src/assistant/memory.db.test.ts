import type { LlmProvider, LlmRequest, LlmResponse } from '@instantlead/integrations';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../../test/context.ts';
import { bookSlot, findSlots } from '../booking.ts';
import { withTenant } from '../db/client.ts';
import { answers, appointments, conversations, leads, messages } from '../db/schema.ts';
import { createFakeLlm } from './fake-llm.ts';

const DAY = 86_400_000;
const fake = createFakeLlm();
const seen: LlmRequest[] = [];
let failSummary = false;
let replies = 0;
const llm: LlmProvider = {
  provider: 'fake',
  model: 'fake',
  complete(req, hints) {
    seen.push(structuredClone(req));
    if (failSummary && req.task === 'memory_summarize')
      return Promise.reject(new Error('summary model down'));
    if (req.task.startsWith('agent_reply'))
      return Promise.resolve<LlmResponse>({
        text: `Welcome back, how can I help? (${++replies})`,
        toolCalls: [],
        stop: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        raw: { provider: 'fake', model: 'fake', data: null },
      });
    return fake.complete(req, hints);
  },
};

let t: TestContext;
let A: string;
let cookie: string;
let n = 9700000000;

beforeAll(async () => {
  t = await createTestContext({ llm });
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
beforeEach(() => {
  failSummary = false;
});

const newPhone = () => String(n++);
const say = (from: string, text: string) =>
  t.app.inject({
    method: 'POST',
    url: '/v1/dev/whatsapp/inbound',
    headers: { cookie },
    payload: { from, text },
  });
const leadOf = async (from: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(leads)
        .where(eq(leads.phoneE164, `+91${from}`)),
    )
  )[0]!;
const lastAgentRequest = () => seen.filter((r) => r.task.startsWith('agent_reply')).at(-1)!;
const stateText = (r: LlmRequest) => r.turns.filter((x) => x.role === 'system').at(-1)!.text;

/** A customer with a history, then silence for `days`. */
async function returningCustomer(days: number) {
  const phone = newPhone();
  await say(phone, 'hello, I would like a cleaning');
  await t.drainAssistant();
  const lead = await leadOf(phone);
  const past = (d: number) => new Date(t.clock.now().getTime() - d * DAY);
  await withTenant(t.ctx.db, A, async (tx) => {
    await tx.update(leads).set({ name: 'Anita Desai' }).where(eq(leads.id, lead.id));
    // What they told us two months ago.
    await tx
      .update(answers)
      .set({ answeredAt: past(0) })
      .where(eq(answers.leadId, lead.id));
    await tx
      .insert(answers)
      .values({
        leadId: lead.id,
        key: 'urgency',
        value: 'this_week',
        answeredAt: new Date(t.clock.now().getTime()),
      })
      .onConflictDoNothing();
    await tx
      .insert(answers)
      .values({
        leadId: lead.id,
        key: 'location',
        value: 'Baner',
        answeredAt: new Date(t.clock.now().getTime()),
      })
      .onConflictDoNothing();
    await tx.insert(appointments).values({
      leadId: lead.id,
      service: 'Consultation',
      resource: 'default',
      startsAt: past(-3),
      endsAt: new Date(past(-3).getTime() + 30 * 60_000),
      busyUntil: new Date(past(-3).getTime() + 35 * 60_000),
      status: 'completed',
      source: 'staff',
    });
    // A visit nobody ever marked: it must not look "upcoming" two months later.
    await tx.insert(appointments).values({
      leadId: lead.id,
      service: 'Consultation',
      resource: 'default',
      startsAt: past(-1),
      endsAt: new Date(past(-1).getTime() + 30 * 60_000),
      busyUntil: new Date(past(-1).getTime() + 35 * 60_000),
      status: 'scheduled',
      source: 'staff',
    });
  });
  t.clock.advance(days * DAY);
  return { phone, lead };
}

describe('returning customers', () => {
  test('after 2 months: history is still there, the gap is stated, old answers are flagged, past visits on file (fetched on demand), the unmarked visit is not "upcoming"', async () => {
    const { phone } = await returningCustomer(62);
    await say(phone, 'hi, I need another cleaning');
    await t.drainAssistant();
    const req = lastAgentRequest();
    const state = stateText(req);
    expect(state).toMatch(/Returning customer: your last conversation with them was 6\d days ago/);
    expect(state).toMatch(/Answers older than 60 days \(re-confirm before relying on them\): .*urgency/);
    // Past visits are not inlined (Context Manager): the model is told they exist and fetches them on demand.
    expect(state).toMatch(/Past visits \/ treatment on file: call get_patient_history/);
    expect(state).not.toMatch(/Consultation, .*\(completed\)/);
    expect(req.tools?.map((x) => x.name)).toContain('get_patient_history');
    expect(state).toMatch(/Upcoming appointments: none/);
    expect(state).toContain('"location":"Baner"'); // answers are still remembered
    // The earlier conversation is part of the model's context, in order.
    const text = req.turns.map((x) => ('text' in x ? x.text : '')).join('\n');
    expect(text).toContain('hello, I would like a cleaning');
    expect(text.indexOf('hello, I would like a cleaning')).toBeLessThan(text.indexOf('another cleaning'));
  });

  test('a recent customer gets no "returning" note and no stale-answer flag', async () => {
    const { phone } = await returningCustomer(2);
    await say(phone, 'one more question');
    await t.drainAssistant();
    const state = stateText(lastAgentRequest());
    expect(state).not.toMatch(/Returning customer/);
    expect(state).not.toMatch(/Answers older than 60 days/);
  });

  test('the old unmarked visit does not block booking again', async () => {
    const { lead } = await returningCustomer(62);
    const s = (await findSlots(t.ctx, A, { service: 'Consultation', limit: 50, spread: false })).slots[4]!;
    const { appointment } = await bookSlot(t.ctx, A, {
      leadId: lead.id,
      service: 'Consultation',
      date: s.date,
      time: s.time,
      source: 'staff',
    });
    expect(appointment.status).toBe('scheduled');
    const all = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.leadId, lead.id)),
    );
    expect(all.filter((a) => a.status === 'lapsed')).toHaveLength(1);
  });

  test('a human takeover from long ago does not mean silence: after 7+ quiet days the assistant resumes (and staff are told)', async () => {
    const phone = newPhone();
    await say(phone, 'please call me, I want to talk to someone');
    await t.drainAssistant();
    await t.owner.query(`update leads set ai_paused = true where phone_e_164 = $1`, [`+91${phone}`]);
    // Recent: still paused, the person who took over is alerted, the assistant stays quiet.
    t.clock.advance(1 * DAY);
    const before = seen.length;
    await say(phone, 'any news?');
    expect(await t.drainAssistant()).toEqual([]);
    expect(seen.length).toBe(before);
    const alerts = await t.drainJobs();
    expect(
      alerts.some(
        (a) =>
          a.queue === 'staff-alert' && /wrote while the assistant is paused/.test(JSON.stringify(a.data)),
      ),
    ).toBe(true);
    // Two months later: the assistant takes it back.
    t.clock.advance(60 * DAY);
    await say(phone, 'hi again, I still need that appointment');
    expect((await t.drainAssistant())[0]).toMatchObject({ status: 'replied' });
    expect((await leadOf(phone)).aiPaused).toBe(false);
    const later = await t.drainJobs();
    expect(later.some((a) => /came back after 6\d days/.test(JSON.stringify(a.data)))).toBe(true);
  });
});

describe('long conversations', () => {
  const insertHistory = async (leadId: string, count: number, start: number) =>
    withTenant(t.ctx.db, A, async (tx) => {
      for (let i = 0; i < count; i++)
        await tx.insert(messages).values({
          leadId,
          direction: i % 2 ? 'out' : 'in',
          kind: 'text',
          body: i % 2 ? `answer ${start + i}` : `question ${start + i}`,
          status: i % 2 ? 'sent' : 'received',
          occurredAt: new Date(t.clock.now().getTime() - (count + 10 - i) * 3_600_000),
        });
    });

  test('past 16 messages the older part is summarised; the summary is refreshed every 6 new messages; a failing summariser keeps the last summary', async () => {
    const phone = newPhone();
    await say(phone, 'hello');
    await t.drainAssistant();
    const lead = await leadOf(phone);
    await insertHistory(lead.id, 50, 0);
    t.clock.advance(60_000);

    await say(phone, 'whitening price?');
    await t.drainAssistant();
    const conv = () =>
      withTenant(
        t.ctx.db,
        A,
        async (tx) => (await tx.select().from(conversations).where(eq(conversations.leadId, lead.id)))[0]!,
      );
    const first = await conv();
    expect(first.summary).toMatch(/Earlier the customer said/);
    expect(lastAgentRequest().turns[0]).toMatchObject({
      role: 'system',
      text: expect.stringMatching(/^Summary of the earlier conversation/),
    });
    const summarisations = () => seen.filter((r) => r.task === 'memory_summarize').length;
    const s1 = summarisations();

    // A few more messages: the stored summary is reused, no new summarisation.
    t.clock.advance(60_000);
    await say(phone, 'and braces?');
    await t.drainAssistant();
    expect(summarisations()).toBe(s1);

    // 20+ new messages (spread over the day, so this is a conversation, not a flood): refreshed.
    t.clock.advance(30 * 3_600_000);
    await withTenant(t.ctx.db, A, async (tx) => {
      for (let i = 0; i < 24; i++)
        await tx.insert(messages).values({
          leadId: lead.id,
          direction: i % 2 ? 'out' : 'in',
          kind: 'text',
          body: `more ${i}`,
          status: i % 2 ? 'sent' : 'received',
          occurredAt: new Date(t.clock.now().getTime() - (25 - i) * 30 * 60_000),
        });
    });
    t.clock.advance(60_000);
    await say(phone, 'and implants?');
    await t.drainAssistant();
    expect(summarisations()).toBe(s1 + 1);
    const refreshed = await conv();
    expect(refreshed.summaryUpTo!.getTime()).toBeGreaterThan(first.summaryUpTo!.getTime());

    // The summariser goes down: the previous summary still reaches the model.
    t.clock.advance(30 * 3_600_000);
    await withTenant(t.ctx.db, A, async (tx) => {
      for (let i = 0; i < 24; i++)
        await tx.insert(messages).values({
          leadId: lead.id,
          direction: i % 2 ? 'out' : 'in',
          kind: 'text',
          body: `later ${i}`,
          status: i % 2 ? 'sent' : 'received',
          occurredAt: new Date(t.clock.now().getTime() - (25 - i) * 30 * 60_000),
        });
    });
    t.clock.advance(60_000);
    failSummary = true;
    await say(phone, 'and a crown?');
    await t.drainAssistant();
    expect((lastAgentRequest().turns[0] as { text: string }).text).toBe(
      `Summary of the earlier conversation: ${refreshed.summary}`,
    );
    // Messages order check for good measure.
    const all = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(messages).where(eq(messages.leadId, lead.id)).orderBy(asc(messages.occurredAt)),
    );
    expect(all.length).toBeGreaterThan(90);
  });
});
