import type { LlmProvider, LlmRequest, LlmResponse, ToolCall } from '@instantlead/integrations';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../../test/context.ts';
import { getActiveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import { appointments, leads, messages, treatmentPlans } from '../db/schema.ts';
import { KEEP_RECENT } from './context.ts';
import { createFakeLlm } from './fake-llm.ts';
import { runTool } from './tools.ts';

/**
 * Context Manager: what the model sees is decided in code. Minimal by default, patient history
 * only through get_patient_history (offered by code, scoped to the lead), and nothing it returns
 * lets the model state a price.
 */
const DAY = 86_400_000;
const fake = createFakeLlm();
const seen: LlmRequest[] = [];
let script: ((req: LlmRequest) => LlmResponse) | null = null;
const llm: LlmProvider = {
  provider: 'fake',
  model: 'fake',
  complete(req, hints) {
    seen.push(structuredClone(req));
    return script && req.task.startsWith('agent_reply')
      ? Promise.resolve(script(req))
      : fake.complete(req, hints);
  },
};
const res = (text: string, toolCalls: ToolCall[] = []): LlmResponse => ({
  text,
  toolCalls,
  stop: toolCalls.length ? 'tool_use' : 'end',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  raw: { provider: 'fake', model: 'fake', data: null },
});

let t: TestContext;
let A: string;
let cookie: string;
let n = 9800000000;

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
  script = null;
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
const toolNames = (r: LlmRequest) => (r.tools ?? []).map((x) => x.name);
const outbound = async (leadId: string) =>
  (
    await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(messages).where(eq(messages.leadId, leadId)).orderBy(asc(messages.occurredAt)),
    )
  )
    .filter((m) => m.direction === 'out')
    .map((m) => m.body);

/** A patient with a long chat, a completed visit and a paid treatment plan (amounts and staff notes included). */
async function patient(opts: { messages?: number } = {}) {
  const phone = newPhone();
  await say(phone, 'hello, I would like a cleaning');
  await t.drainAssistant();
  const lead = await leadOf(phone);
  await withTenant(t.ctx.db, A, async (tx) => {
    for (let i = 0; i < (opts.messages ?? 0); i++)
      await tx.insert(messages).values({
        leadId: lead.id,
        direction: i % 2 ? 'out' : 'in',
        kind: 'text',
        body:
          i % 2
            ? `reply number ${i} about the clinic and its services`
            : `question number ${i} about my teeth`,
        status: i % 2 ? 'sent' : 'received',
        occurredAt: new Date(t.clock.now().getTime() - (opts.messages! + 5 - i) * 3_600_000),
      });
    const at = new Date(t.clock.now().getTime() - 40 * DAY);
    await tx.insert(appointments).values({
      leadId: lead.id,
      service: 'Consultation',
      resource: 'default',
      startsAt: at,
      endsAt: new Date(at.getTime() + 30 * 60_000),
      busyUntil: new Date(at.getTime() + 35 * 60_000),
      status: 'completed',
      source: 'staff',
    });
    await tx.insert(treatmentPlans).values({
      leadId: lead.id,
      title: 'Root canal, 3 visits',
      service: 'Consultation',
      status: 'in_progress',
      visitsPlanned: 3,
      visitsDone: 1,
      valueInr: 14500,
      paidInr: 5000,
      notes: 'STAFF ONLY: patient anxious, offered sedation',
    });
  });
  t.clock.advance(60_000);
  return { phone, lead };
}

describe('minimal context by default', () => {
  test('a long chat sends the summary plus the recent window, never the whole history; past visits stay out', async () => {
    const { phone } = await patient({ messages: 60 });
    await say(phone, 'ok thanks');
    await t.drainAssistant();
    const req = lastAgentRequest();
    const chat = req.turns.filter((x) => x.role === 'user' || x.role === 'assistant');
    const text = req.turns.map((x) => ('text' in x ? x.text : '')).join('\n');
    expect(req.turns[0]).toMatchObject({
      role: 'system',
      text: expect.stringMatching(/^Summary of the earlier/),
    });
    expect(chat.length).toBeLessThanOrEqual(KEEP_RECENT + 1); // + a placeholder first user turn when the window starts on a reply
    expect(text).not.toContain('question number 0 about');
    expect(text).not.toMatch(/Root canal|completed\)|14500|sedation/);
    expect(toolNames(req)).toContain('get_patient_history');

    // Audit: per-turn conversation context (chars / 4 ~ tokens), recorded in docs/PROGRESS.
    console.info(
      `[context audit] conversation turns: ${text.length} chars (~${Math.round(text.length / 4)} tokens), ${chat.length} chat turns; system prompt ${req.system.length} chars; tools ${JSON.stringify(req.tools).length} chars`,
    );
  });

  test('a new lead with no records is not offered the history tool, and the state does not mention it', async () => {
    const phone = newPhone();
    await say(phone, 'hi, do you do braces?');
    await t.drainAssistant();
    const req = lastAgentRequest();
    expect(toolNames(req)).not.toContain('get_patient_history');
    expect(JSON.stringify(req.turns)).not.toMatch(/treatment on file/);
  });
});

describe('history on demand, scoped and permissioned in code', () => {
  test('the tool returns only this patient, without amounts or staff notes', async () => {
    const mine = await patient();
    const other = await patient();
    await withTenant(t.ctx.db, A, (tx) =>
      tx
        .update(treatmentPlans)
        .set({ title: 'Implant for someone else' })
        .where(eq(treatmentPlans.leadId, other.lead.id)),
    );
    const config = await withTenant(t.ctx.db, A, async (tx) => (await getActiveConfig(tx))!.config);
    const out = await runTool(
      { deps: t.ctx, tenantId: A, leadId: mine.lead.id, config, historyAccess: true },
      'get_patient_history',
      {},
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('Root canal, 3 visits');
    expect(out.content).toContain('1 of 3 done');
    expect(out.content).toMatch(/Consultation/);
    expect(out.content).not.toMatch(/Implant for someone else|14500|5000|sedation|STAFF ONLY/);
  });

  test('the model cannot call it unless code granted access, and never on the phone channel', async () => {
    const { lead } = await patient();
    const config = await withTenant(t.ctx.db, A, async (tx) => (await getActiveConfig(tx))!.config);
    const base = { deps: t.ctx, tenantId: A, leadId: lead.id, config };
    expect(await runTool(base, 'get_patient_history', {})).toMatchObject({
      isError: true,
      invalidArguments: true,
    });
    expect(
      await runTool({ ...base, historyAccess: true, channel: 'phone' }, 'get_patient_history', {}),
    ).toMatchObject({ isError: true });
  });

  test('end to end: "what did we do last time?" fetches the record, the reply uses it', async () => {
    const { phone, lead } = await patient();
    await say(phone, 'what was done last time? when is my next sitting');
    await t.drainAssistant();
    const toolCalls = seen.flatMap((r) =>
      r.turns.flatMap((x) => (x.role === 'assistant' ? x.toolCalls.map((c) => c.name) : [])),
    );
    expect(toolCalls).toContain('get_patient_history');
    expect((await outbound(lead.id)).at(-1)).toMatch(/Root canal, 3 visits is 1 of 3 done/);
  });
});

describe('hallucination prevention', () => {
  test('a price the model makes up about past treatment is never sent: one repair, then staff', async () => {
    const { phone, lead } = await patient();
    script = (req) =>
      req.turns.some((x) => x.role === 'tool_results')
        ? res('Your root canal cost ₹4,500 last time, the next one is the same.')
        : res('', [{ id: 'h', name: 'get_patient_history', input: {} }]);
    await say(phone, 'how much did my last treatment cost?');
    await t.drainAssistant();
    const sent = await outbound(lead.id);
    expect(sent.join('\n')).not.toContain('4,500');
    const [l] = await withTenant(t.ctx.db, A, (tx) => tx.select().from(leads).where(eq(leads.id, lead.id)));
    expect(l?.aiPaused).toBe(true);
  });
});
