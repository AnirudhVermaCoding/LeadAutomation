import { DAY, HOUR } from '@instantlead/core';
import { eq, inArray, lt, sql } from 'drizzle-orm';
import { audit, type Actor } from './audit.ts';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Db, type TenantTx, type Tx } from './db/client.ts';
import {
  answers,
  appointments,
  calls,
  consents,
  conversations,
  events,
  leads,
  llmRuns,
  messages,
  oauthNonces,
  opportunities,
  treatmentPlans,
  waitlistEntries,
} from './db/schema.ts';
import { QUEUES, type Enqueue } from './jobs.ts';
import type { LeadDeps } from './leads.ts';

/** Patient name and phone sit in the clinic's Google Calendar events: queue their removal (before the rows go). */
async function queueCalendarRemovals(tx: TenantTx, enqueue: Enqueue, tenantId: string, leadIds: string[]) {
  if (!leadIds.length) return;
  const rows = await tx
    .select({ eventId: appointments.googleEventId, calendarId: appointments.googleCalendarId })
    .from(appointments)
    .where(inArray(appointments.leadId, leadIds));
  const events = rows.flatMap((r) => (r.eventId ? [{ eventId: r.eventId, calendarId: r.calendarId }] : []));
  if (events.length) await enqueue(tx, QUEUES.calendarRemove, { tenantId, events });
}

/**
 * DPDP erasure: delete the lead and everything about them (messages, consents, answers,
 * appointments, sequences cascade). The opt-out suppression (a keyed hash, not the phone)
 * deliberately survives, so an erased person who opted out stays opted out.
 */
export async function eraseLead(
  tx: TenantTx,
  deps: { clock: LeadDeps['clock']; enqueue: Enqueue },
  tenantId: string,
  actor: Actor,
  leadId: string,
) {
  const clock = deps.clock;
  await queueCalendarRemovals(tx, deps.enqueue, tenantId, [leadId]);
  const [gone] = await tx.delete(leads).where(eq(leads.id, leadId)).returning({ id: leads.id });
  if (gone) await audit(tx, clock, actor, { action: 'lead.erased', entityType: 'lead', entityId: leadId });
  return Boolean(gone);
}

/** Keep the counts, drop the person: no name, email, phone, message text, answers or consent evidence. */
async function anonymizeLead(tx: Tx, leadId: string) {
  await tx
    .update(leads)
    .set({ name: null, email: null, phoneE164: `anonymized:${leadId}`, sourceDetails: null })
    .where(eq(leads.id, leadId));
  await tx.update(messages).set({ body: '[removed]', payload: null }).where(eq(messages.leadId, leadId));
  await tx.delete(answers).where(eq(answers.leadId, leadId));
  await tx.update(consents).set({ evidence: null }).where(eq(consents.leadId, leadId));
  await tx
    .update(appointments)
    .set({ notes: null, attendeeName: null, googleEventId: null, googleCalendarId: null })
    .where(eq(appointments.leadId, leadId));
  await tx.update(calls).set({ summary: null, toolResults: {} }).where(eq(calls.leadId, leadId));
  await tx
    .update(treatmentPlans)
    .set({ title: '[removed]', notes: null, attendeeName: null })
    .where(eq(treatmentPlans.leadId, leadId));
  await tx.update(waitlistEntries).set({ attendeeName: null }).where(eq(waitlistEntries.leadId, leadId));
}

/**
 * Daily: for each tenant with a retention period, anonymize or delete leads whose last activity
 * (received, last message, last appointment) is older than that — never anyone with an
 * upcoming appointment.
 */
export async function runRetention(
  deps: LeadDeps & { db: Db; system: { listTenants(): Promise<{ id: string }[]> } },
) {
  const now = deps.clock.now();
  const done: Record<string, number> = {};
  for (const { id: tenantId } of await deps.system.listTenants()) {
    done[tenantId] = await withTenant(deps.db, tenantId, async (tx) => {
      // Operational data does not live for ever: single-use OAuth states after a day, domain events
      // (the webhook outbox and history) after 180 days, AI call logs after 400 days (a year of usage history).
      await tx.delete(oauthNonces).where(lt(oauthNonces.createdAt, new Date(now.getTime() - DAY)));
      await tx.delete(events).where(lt(events.occurredAt, new Date(now.getTime() - 180 * DAY)));
      await tx.delete(llmRuns).where(lt(llmRuns.occurredAt, new Date(now.getTime() - 400 * DAY)));
      const privacy = (await getActiveConfig(tx))?.config.privacy;
      if (!privacy?.retention_days) return 0;
      const cutoff = new Date(now.getTime() - privacy.retention_days * 24 * HOUR);
      const stale = (
        await tx.execute<{ id: string }>(sql`
          select l.id from leads l
          where l.phone_e_164 not like 'anonymized:%'
            and greatest(
              l.received_at,
              coalesce((select max(m.occurred_at) from messages m where m.lead_id = l.id), l.received_at),
              coalesce((select max(a.starts_at) from appointments a where a.lead_id = l.id), l.received_at),
              coalesce((select max(c.started_at) from calls c where c.lead_id = l.id), l.received_at),
              coalesce((select max(p.updated_at) from treatment_plans p where p.lead_id = l.id), l.received_at)
            ) < ${cutoff}
            -- An open treatment or a recall still ahead is an ongoing relationship, not stale data.
            and not exists (select 1 from treatment_plans p where p.lead_id = l.id
              and (p.status in ('accepted', 'in_progress') or p.recall_due_at > ${now}))
          limit 1000`)
      ).rows;
      await queueCalendarRemovals(
        tx,
        deps.enqueue,
        tenantId,
        stale.map((l) => l.id),
      );
      for (const { id } of stale) {
        if (privacy.mode === 'delete') await tx.delete(leads).where(eq(leads.id, id));
        else await anonymizeLead(tx, id);
      }
      if (stale.length)
        await audit(
          tx,
          deps.clock,
          { type: 'system' },
          {
            action: `retention.${privacy.mode}`,
            entityType: 'lead',
            details: { count: stale.length, retentionDays: privacy.retention_days },
          },
        );
      return stale.length;
    });
  }
  return done;
}

/** Everything the tenant holds about its leads, as JSON (data portability / client offboarding). */
export async function exportTenantData(tx: Tx) {
  return {
    exportedAt: new Date().toISOString(),
    config: (await getActiveConfig(tx))?.config ?? null,
    leads: await tx.select().from(leads),
    consents: await tx.select().from(consents),
    conversations: await tx.select().from(conversations),
    messages: await tx.select().from(messages),
    answers: await tx.select().from(answers),
    appointments: await tx.select().from(appointments),
    treatmentPlans: await tx.select().from(treatmentPlans),
    calls: await tx.select().from(calls),
    waitlist: await tx.select().from(waitlistEntries),
    opportunities: await tx.select().from(opportunities),
  };
}
