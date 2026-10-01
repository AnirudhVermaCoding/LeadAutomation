import type { TenantConfig } from '@instantlead/config';
import { scoreLead } from '@instantlead/core';
import { eq } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/client.ts';
import { answers, leads } from '../db/schema.ts';
import { emit, transitionLead, transitionLeadIfAllowed, type LeadDeps } from '../leads.ts';
import type { Db } from '../db/client.ts';
import { toolSchemas, type ToolName } from './prompt.ts';

export interface ToolContext {
  deps: LeadDeps & { db: Db };
  tenantId: string;
  leadId: string;
  config: TenantConfig;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

export async function loadAnswers(tx: Tx, leadId: string) {
  const rows = await tx
    .select({ key: answers.key, value: answers.value })
    .from(answers)
    .where(eq(answers.leadId, leadId));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Record one answer, then let deterministic scoring decide the lead's tier (never the LLM). */
async function recordAnswer(c: ToolContext, input: { key: string; value: string }): Promise<ToolOutcome> {
  const question = c.config.qualification.questions.find((q) => q.key === input.key);
  if (!question) return { content: `Unknown question "${input.key}"`, isError: true };
  let value = input.value.trim();
  if (question.options) {
    const match = question.options.find((o) => o.toLowerCase() === value.toLowerCase().replaceAll(' ', '_'));
    if (!match)
      return {
        content: `"${value}" is not an option for ${input.key}. Use one of: ${question.options.join(', ')}`,
        isError: true,
      };
    value = match;
  }
  if (question.type === 'yes_no' && !['yes', 'no'].includes(value.toLowerCase()))
    return { content: `Answer ${input.key} with "yes" or "no"`, isError: true };

  const { clock } = c.deps;
  return withTenant(c.deps.db, c.tenantId, async (tx) => {
    await tx
      .insert(answers)
      .values({ leadId: c.leadId, key: input.key, value, answeredAt: clock.now() })
      .onConflictDoUpdate({ target: [answers.leadId, answers.key], set: { value, answeredAt: clock.now() } });

    const result = scoreLead(c.config.qualification, await loadAnswers(tx, c.leadId));
    if (result.status === 'disqualified') {
      await transitionLeadIfAllowed(tx, c.leadId, { type: 'DISQUALIFIED' });
      await emit(tx, clock, 'lead.disqualified', { leadId: c.leadId, question: result.question });
      return {
        content: JSON.stringify({
          saved: true,
          status: 'disqualified',
          note: 'This answer means the lead is not a fit. Politely let them know and offer a call from the team.',
        }),
      };
    }
    await tx.update(leads).set({ score: result.score }).where(eq(leads.id, c.leadId));
    if (result.status === 'incomplete')
      return {
        content: JSON.stringify({ saved: true, status: 'incomplete', still_missing: result.missing }),
      };

    const [before] = await tx
      .select({ tier: leads.tier, state: leads.state })
      .from(leads)
      .where(eq(leads.id, c.leadId));
    const after = await transitionLeadIfAllowed(tx, c.leadId, { type: 'QUALIFIED', tier: result.tier });
    if (after && (before?.state !== 'qualified' || before.tier !== result.tier))
      await emit(tx, clock, 'lead.qualified', { leadId: c.leadId, tier: result.tier, score: result.score });
    return { content: JSON.stringify({ saved: true, status: 'qualified', still_missing: [] }) };
  });
}

function lookupKnowledge(c: ToolContext, input: { query: string }): ToolOutcome {
  const terms = input.query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  const hits = c.config.qualification.knowledge
    .map((k) => ({
      k,
      score: terms.filter((t) => `${k.title} ${k.content}`.toLowerCase().includes(t)).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!hits.length)
    return {
      content:
        'No information about that. Do not guess: say you will check with the team, or offer a call back.',
    };
  return { content: hits.map(({ k }) => `${k.title}: ${k.content}`).join('\n') };
}

export async function escalate(c: Omit<ToolContext, 'config'>, reason: string) {
  await withTenant(c.deps.db, c.tenantId, async (tx) => {
    await transitionLead(tx, c.leadId, { type: 'HUMAN_TAKEOVER' });
    await emit(tx, c.deps.clock, 'lead.escalated', { leadId: c.leadId, reason });
  });
}

/** Validate the model's arguments, then run the tool. Bad arguments go back to the model as an error. */
export async function runTool(c: ToolContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const schemas = toolSchemas(c.config);
  if (!(name in schemas)) return { content: `Unknown tool ${name}`, isError: true };
  const parsed = schemas[name as ToolName].safeParse(rawInput);
  if (!parsed.success) return { content: `Invalid arguments: ${parsed.error.message}`, isError: true };
  const input = parsed.data as Record<string, string>;

  switch (name as ToolName) {
    case 'record_answer':
      return recordAnswer(c, input as { key: string; value: string });
    case 'lookup_knowledge':
      return lookupKnowledge(c, input as { query: string });
    case 'escalate_to_human':
      await escalate(c, input.reason ?? 'escalated');
      return {
        content:
          'Done: a team member will take over this conversation. Tell the lead they will hear from a person shortly.',
      };
    case 'mark_disqualified':
      await withTenant(c.deps.db, c.tenantId, async (tx) => {
        await transitionLeadIfAllowed(tx, c.leadId, { type: 'DISQUALIFIED' });
        await emit(tx, c.deps.clock, 'lead.disqualified', { leadId: c.leadId, reason: input.reason });
      });
      return { content: 'Marked as not a fit. Close politely and offer a call from the team.' };
  }
}
