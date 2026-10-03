import type { TenantConfig } from '@instantlead/config';
import type { LlmProvider, LlmRequest, LlmResponse } from '@instantlead/integrations';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../../test/context.ts';
import { bookSlot, findSlots } from '../booking.ts';
import { getActiveConfig, saveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import { appointments, events, leads, messages } from '../db/schema.ts';
import { createFakeLlm } from './fake-llm.ts';
import { checkReply } from './guard.ts';
import { buildSystemPrompt, buildTools } from './prompt.ts';
import { runTool } from './tools.ts';

const fake = createFakeLlm();
let script: ((req: LlmRequest) => LlmResponse) | null = null;
const llm: LlmProvider = {
  provider: 'fake',
  model: 'fake',
  complete: async (req, hints) => (script && req.task === 'agent_reply' ? script(req) : fake.complete(req, hints)),
};
const text = (t: string): LlmResponse => ({
  text: t,
  toolCalls: [],
  stop: 'end',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  raw: { provider: 'fake', model: 'fake', data: null },
});

let t: TestContext;
let A: string;
let cookie: string;
let n = 0;

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

async function setConfig(change: (c: TenantConfig) => TenantConfig) {
  return withTenant(t.ctx.db, A, async (tx) => {
    const config = change(structuredClone((await getActiveConfig(tx))!.config));
    await saveConfig(tx, t.clock, { type: 'system' }, config);
    return config;
  });
}
async function newLead() {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/leads',
    headers: { cookie },
    payload: { phone: `98722${String(++n).padStart(5, '0')}`, name: 'Priya', consent: { granted: true } },
  });
  await t.drainJobs();
  return (res.json() as { lead_id: string }).lead_id;
}
const tool = (config: TenantConfig, leadId: string) => ({ deps: t.ctx, tenantId: A, leadId, config });
const lead = (id: string) =>
  withTenant(t.ctx.db, A, async (tx) => (await tx.select().from(leads).where(eq(leads.id, id)))[0]!);

describe('autonomy: approval', () => {
  test('book needs approval: the assistant books as pending even in auto-confirm mode', async () => {
    const config = await setConfig((c) => ({
      ...c,
      booking: { ...c.booking, mode: 'auto_confirm' },
      autonomy: { book: 'approval' },
    }));
    const leadId = await newLead();
    const [slot] = (await findSlots(t.ctx, A, { service: 'Consultation', limit: 1, spread: false })).slots;
    const out = await runTool(tool(config, leadId), 'book_slot', {
      service: 'Consultation',
      date: slot!.date,
      time: slot!.time,
    });
    expect(JSON.parse(out.content)).toMatchObject({ status: 'pending staff confirmation' });
    const [appt] = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.leadId, leadId)),
    );
    expect(appt?.status).toBe('pending');
  });

  test('cancel / reschedule need approval: nothing changes, staff take over', async () => {
    const config = await setConfig((c) => ({ ...c, autonomy: { cancel: 'approval', reschedule: 'approval' } }));
    const leadId = await newLead();
    const [slot, later] = (await findSlots(t.ctx, A, { service: 'Consultation', limit: 200, spread: false })).slots
      .slice(0, 2);
    await bookSlot(t.ctx, A, { leadId, service: 'Consultation', date: slot!.date, time: slot!.time, source: 'staff' });
    const out = await runTool(tool(config, leadId), 'cancel', {});
    expect(out.content).toMatch(/^Not done/);
    const res = await runTool(tool(config, leadId), 'reschedule', { date: later!.date, time: later!.time });
    expect(res.content).toMatch(/^Not done/);
    const appts = await withTenant(t.ctx.db, A, (tx) =>
      tx.select().from(appointments).where(eq(appointments.leadId, leadId)),
    );
    expect(appts.map((a) => a.status)).toEqual(['scheduled']);
    expect((await lead(leadId)).aiPaused).toBe(true);
  });

  test('refunds, special prices and complaints go to staff with the category recorded', async () => {
    const config = await setConfig((c) => ({ ...c, autonomy: {} }));
    const leadId = await newLead();
    await runTool(tool(config, leadId), 'escalate_to_human', {
      reason: 'asks for a refund of the deposit',
      category: 'refund',
    });
    const [ev] = await withTenant(t.ctx.db, A, (tx) =>
      tx
        .select()
        .from(events)
        .where(and(eq(events.leadId, leadId), eq(events.type, 'lead.escalated'))),
    );
    expect(ev?.payload).toMatchObject({ category: 'refund' });
    expect((await lead(leadId)).aiPaused).toBe(true);
  });
});

describe('autonomy: off', () => {
  test('an action set to off is neither offered to the model nor callable', async () => {
    const config = await setConfig((c) => ({ ...c, autonomy: { cancel: 'off', book: 'off', faq: 'off' } }));
    const names = buildTools(config).map((x) => x.name);
    expect(names).not.toContain('cancel');
    expect(names).not.toContain('book_slot');
    expect(names).not.toContain('lookup_knowledge');
    expect(names).toContain('get_available_slots');
    const leadId = await newLead();
    const out = await runTool(tool(config, leadId), 'cancel', {});
    expect(out).toMatchObject({ isError: true, invalidArguments: true });
    // FAQ off: the clinic's knowledge is not in the prompt, so the model has nothing to answer facts from.
    const knowledge = config.qualification.knowledge[0]!.content;
    expect(buildSystemPrompt(config)).not.toContain(knowledge);
  });
});

describe('never: clinical actions and invented facts', () => {
  test('there is no tool that changes treatment, and unknown tools are rejected', async () => {
    const config = await setConfig((c) => ({ ...c, autonomy: {} }));
    const names = buildTools(config).map((x) => x.name);
    expect(names.some((x) => /treat|prescri|diagnos|plan/.test(x))).toBe(false);
    const leadId = await newLead();
    const out = await runTool(tool(config, leadId), 'update_treatment_plan', { status: 'completed' });
    expect(out).toMatchObject({ isError: true, invalidArguments: true });
    expect(buildSystemPrompt(config)).toMatch(/Never diagnose a condition\./);
  });

  test('the output guard blocks diagnosis, treatment decisions and home remedies, not service names', () => {
    const ctx = { sources: '', allowedUrls: [], noMedicalAdvice: true, language: 'en' };
    expect(checkReply('From what you describe, you probably have a cavity.', ctx)).toHaveLength(1);
    expect(checkReply('You need a root canal, it is nothing serious.', ctx)[0]).toMatch(/clinical/);
    expect(checkReply('Gargle with salt water tonight and see the dentist.', ctx)).toHaveLength(1);
    expect(checkReply("I can't say what's causing it. Shall I book a Root canal consultation?", ctx)).toEqual([]);
  });

  test('a price the clinic never gave is never sent (repair once, then hand over)', async () => {
    await setConfig((c) => ({ ...c, autonomy: {} }));
    const phone = `98733${String(++n).padStart(5, '0')}`;
    script = () => text('Cleaning costs just ₹99 today!');
    await t.app.inject({
      method: 'POST',
      url: '/v1/dev/whatsapp/inbound',
      headers: { cookie },
      payload: { from: phone, text: 'how much is a cleaning?' },
    });
    await t.drainAssistant();
    script = null;
    const out = await withTenant(t.ctx.db, A, async (tx) => {
      const [l] = await tx.select().from(leads).where(eq(leads.phoneE164, `+91${phone}`));
      return {
        lead: l!,
        sent: await tx
          .select({ body: messages.body })
          .from(messages)
          .where(and(eq(messages.leadId, l!.id), eq(messages.direction, 'out'))),
      };
    });
    expect(out.sent.some((m) => m.body.includes('99'))).toBe(false);
    expect(out.lead.aiPaused).toBe(true);
  });
});
