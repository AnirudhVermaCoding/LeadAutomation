/**
 * Context Manager: code, never a model, decides what the assistant sees.
 * - By default: the per-turn CRM state (prompt.ts stateMessage) and a short recent window.
 * - Older conversation: a rolling summary (memory_summarize).
 * - Patient history (past visits, treatment plans): never sent by default; the model may fetch it
 *   with get_patient_history, which is offered only when hasHistory() says there is some and the
 *   channel is the customer's own WhatsApp number (agent.ts). The tool reads this lead only.
 */
import type { TenantConfig } from '@instantlead/config';
import { formatSlot } from '@instantlead/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type Tx } from '../db/client.ts';
import { appointments, conversations, treatmentPlans } from '../db/schema.ts';
import { runStructured } from '../llm-router.ts';
import type { AssistantDeps } from './agent.ts';
import { PRICE, redact } from './guard.ts';
import { jsonSchema } from './prompt.ts';

/** Messages sent verbatim each turn; anything older is summarised once the conversation passes SUMMARIZE_AFTER. */
export const KEEP_RECENT = 12;
const SUMMARIZE_AFTER = 16;
const RESUMMARIZE_EVERY = 6;
const FALLBACK_MAX = 30;
const HISTORY_LIMIT = 5;
const PAST = ['completed', 'no_show', 'cancelled', 'lapsed'] as const;

export type StoredMessage = {
  direction: 'in' | 'out';
  body: string;
  payload: Record<string, unknown> | null;
};

const SummarySchema = z.strictObject({ summary: z.string().max(2000) });

/**
 * The summary plus the recent window. A reused summary may be a few messages behind the window:
 * then `recent` starts right after what the summary covers, so no message falls in between.
 */
export async function conversationMemory(
  deps: AssistantDeps,
  tenantId: string,
  leadId: string,
  config: TenantConfig,
  all: (StoredMessage & { occurredAt: Date })[],
  conversation: { summary: string | null; summaryUpTo: Date | null } | null,
): Promise<{ summary: string | null; recent: StoredMessage[] }> {
  if (all.length <= SUMMARIZE_AFTER) return { summary: null, recent: all };
  const older = all.slice(0, -KEEP_RECENT);
  const recent = all.slice(-KEEP_RECENT);
  const upTo = older.at(-1)!.occurredAt;
  const since = (d: Date) => all.filter((m) => m.occurredAt > d);
  const unsummarized = conversation?.summaryUpTo
    ? older.filter((m) => m.occurredAt > conversation.summaryUpTo!).length
    : older.length;
  if (conversation?.summary && conversation.summaryUpTo && unsummarized < RESUMMARIZE_EVERY)
    return { summary: conversation.summary, recent: since(conversation.summaryUpTo) };
  try {
    const transcript = older
      .map(
        (m) =>
          `${m.direction === 'in' ? 'Customer' : 'Assistant'}: ${m.direction === 'in' ? redact(m.body) : m.body}`,
      )
      .join('\n');
    const { summary } = await runStructured(
      deps,
      config,
      {
        task: 'memory_summarize',
        system:
          'Summarise this WhatsApp conversation between a customer and a business assistant in under 120 words: what the customer wants, facts they gave (no phone numbers or emails), what was offered or agreed, and anything still open.',
        turns: [{ role: 'user', text: transcript }],
        maxTokens: 400,
        output: { name: 'summary', schema: jsonSchema(SummarySchema) },
      },
      SummarySchema,
      { tenantId, leadId, promptVersion: 'summary-v1' },
    );
    await withTenant(deps.db, tenantId, (tx) =>
      tx.update(conversations).set({ summary, summaryUpTo: upTo }).where(eq(conversations.leadId, leadId)),
    );
    return { summary, recent };
  } catch {
    // Fall back to the last known summary and what came after it (capped while summaries keep failing).
    if (conversation?.summary && conversation.summaryUpTo)
      return { summary: conversation.summary, recent: since(conversation.summaryUpTo).slice(-FALLBACK_MAX) };
    return { summary: null, recent };
  }
}

/** Does this lead have anything get_patient_history could return? (Decides whether the tool is offered.) */
export async function hasHistory(tx: Tx, leadId: string): Promise<boolean> {
  const [visit] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.leadId, leadId), inArray(appointments.status, [...PAST])))
    .limit(1);
  if (visit) return true;
  const [plan] = await tx
    .select({ id: treatmentPlans.id })
    .from(treatmentPlans)
    .where(eq(treatmentPlans.leadId, leadId))
    .limit(1);
  return Boolean(plan);
}

/**
 * The get_patient_history tool: this lead's last visits and treatment plans, newest first.
 * Clinic-entered facts only: no amounts (money questions go to staff), no staff notes.
 */
export async function patientHistory(
  tx: Tx,
  leadId: string,
  timezone: string,
  about: 'visits' | 'treatment' | 'both' = 'both',
) {
  const visits = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.leadId, leadId), inArray(appointments.status, [...PAST])))
    .orderBy(desc(appointments.startsAt))
    .limit(HISTORY_LIMIT);
  const plans = await tx
    .select()
    .from(treatmentPlans)
    .where(eq(treatmentPlans.leadId, leadId))
    .orderBy(desc(treatmentPlans.updatedAt))
    .limit(HISTORY_LIMIT);
  return {
    past_visits: (about === 'treatment' ? [] : visits).map((a) => ({
      service: a.service,
      when: formatSlot(a.startsAt, timezone),
      status: a.status.replace('_', '-'),
      ...(a.attendeeName && { for: a.attendeeName }),
    })),
    treatment_plans: (about === 'visits' ? [] : plans).map((p) => ({
      // Staff type the title freely; an amount in it must not become a price the model may quote.
      treatment: p.title
        .replace(PRICE, '')
        .replace(/\s+([,.;)])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim(),
      status: p.status.replace('_', ' '),
      visits: p.visitsPlanned ? `${p.visitsDone} of ${p.visitsPlanned} done` : `${p.visitsDone} done`,
      ...(p.nextVisitDueAt && { next_visit_due: formatSlot(p.nextVisitDueAt, timezone) }),
      ...(p.attendeeName && { for: p.attendeeName }),
    })),
    note: 'From the clinic records. Share only what they asked about; never interpret it medically. Costs and payments: escalate_to_human (account).',
  };
}
