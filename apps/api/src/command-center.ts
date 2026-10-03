import type { TenantConfig } from '@instantlead/config';
import { addDays, localParts, zonedTimeToUtc } from '@instantlead/core';
import { sql } from 'drizzle-orm';
import type { Tx } from './db/client.ts';

const n = (v: unknown) => Number(v ?? 0);

/**
 * The owner's view: what happened today, what needs a person now, and what the assistant achieved in
 * the last 30 days. Every number is counted from records (business-clock timestamps); money appears only
 * where the clinic entered it on a treatment plan, otherwise it is reported as unavailable (null).
 */
export async function commandCenter(tx: Tx, config: TenantConfig, now: Date) {
  const tz = config.locale.timezone;
  const today = localParts(now, tz).date;
  const start = zonedTimeToUtc(today, '00:00', tz);
  const end = zonedTimeToUtc(addDays(today, 1), '00:00', tz);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const soon = new Date(now.getTime() + 86_400_000);

  const t = (
    await tx.execute<Record<string, string>>(sql`
    select
      (select count(*) from leads where received_at >= ${start} and received_at < ${end} and not_a_lead is null) as enquiries,
      (select count(*) from events where type = 'appointment.booked' and occurred_at >= ${start} and occurred_at < ${end}) as bookings,
      (select count(*) from events where type in ('appointment.confirmed', 'appointment.lead_confirmed') and occurred_at >= ${start} and occurred_at < ${end}) as confirmations,
      (select count(*) from appointments where status = 'completed' and starts_at >= ${start} and starts_at < ${end}) as attended,
      (select count(*) from events where type = 'appointment.cancelled' and occurred_at >= ${start} and occurred_at < ${end}) as cancellations,
      (select count(*) from appointments where status = 'no_show' and starts_at >= ${start} and starts_at < ${end}) as no_shows,
      (select count(*) from opportunities where status = 'won' and ai_acted and outcome_at >= ${start} and outcome_at < ${end}) as recovered,
      (select count(*) from events where type in ('opportunity.acted', 'slot.offered') and occurred_at >= ${start} and occurred_at < ${end})
        + (select count(*) from enrollment_steps s join enrollments e on e.id = s.enrollment_id
           where s.status = 'sent' and e.kind in ('followup', 'no_show_recovery') and s.done_at >= ${start} and s.done_at < ${end}) as follow_ups,
      (select count(*) from events where type = 'lead.escalated' and occurred_at >= ${start} and occurred_at < ${end}) as escalations,
      (select count(*) from leads where ai_paused and state <> 'opted_out') as unresolved,
      (select count(*) from calls where started_at >= ${start} and started_at < ${end}) as calls`)
  ).rows[0]!;

  const list = async <T>(q: ReturnType<typeof sql>) =>
    (await tx.execute<T & Record<string, unknown>>(q)).rows;
  const attention = {
    // Waiting for a person: AI paused (escalated or taken over) and the patient wrote since our last reply.
    staff: await list<{
      lead_id: string;
      name: string | null;
      phone: string;
      reason: string | null;
      since: Date;
    }>(sql`
      select l.id as lead_id, l.name, l.phone_e_164 as phone,
        (select e.payload->>'reason' from events e where e.lead_id = l.id and e.type = 'lead.escalated' order by e.occurred_at desc limit 1) as reason,
        coalesce(c.last_inbound_at, l.received_at) as since
      from leads l left join conversations c on c.lead_id = l.id
      where l.ai_paused and l.state <> 'opted_out'
      order by since desc limit 20`),
    urgent: await list<{ lead_id: string; name: string | null; phone: string; at: Date }>(sql`
      select distinct on (l.id) l.id as lead_id, l.name, l.phone_e_164 as phone, e.occurred_at as at
      from events e join leads l on l.id = e.lead_id
      where e.type in ('lead.escalated', 'call.emergency') and e.occurred_at >= ${dayAgo} and l.ai_paused
        and (e.type = 'call.emergency' or e.payload->>'reason' ilike '%emergency%' or e.payload->>'category' = 'clinical')
      order by l.id, e.occurred_at desc limit 20`),
    unconfirmed: await list<{
      id: string;
      lead_id: string;
      name: string | null;
      service: string;
      starts_at: Date;
      status: string;
    }>(sql`
      select a.id, a.lead_id, l.name, a.service, a.starts_at, a.status
      from appointments a join leads l on l.id = a.lead_id
      where a.status in ('pending', 'scheduled') and a.starts_at >= ${now} and a.starts_at < ${soon}
      order by a.starts_at limit 20`),
    opportunities: await list<{
      id: string;
      kind: string;
      status: string;
      reason: string;
      lead_id: string | null;
      name: string | null;
      slot_starts_at: Date | null;
      value_inr: string | null;
    }>(sql`
      select o.id, o.kind, o.status, o.reason, o.lead_id, l.name, o.slot_starts_at, o.value_inr
      from opportunities o left join leads l on l.id = o.lead_id
      where o.status in ('open', 'needs_approval', 'actioned')
        and o.kind in ('STALLED_TREATMENT', 'EMPTY_SLOT', 'PAYMENT_FOLLOWUP')
        and (o.kind <> 'EMPTY_SLOT' or o.slot_starts_at >= ${now})
      order by o.priority desc, o.detected_at limit 30`),
    needsApproval: n(
      (
        await tx.execute<{ c: string }>(
          sql`select count(*) as c from opportunities where status = 'needs_approval'`,
        )
      ).rows[0]?.c,
    ),
  };

  const i = (
    await tx.execute<Record<string, string | null>>(sql`
    select
      (select count(distinct lead_id) from messages where direction = 'out' and idempotency_key like 'ai:%' and occurred_at >= ${monthAgo}) as conversations,
      (select count(*) from calls where started_at >= ${monthAgo}) as calls,
      (select count(*) from events e join appointments a on a.id = (e.payload->>'appointmentId')::uuid
        where e.type = 'appointment.booked' and a.source = 'assistant' and e.occurred_at >= ${monthAgo}) as booked,
      (select count(*) from opportunities where kind = 'EMPTY_SLOT' and status = 'won' and ai_acted and outcome_at >= ${monthAgo}) as slots,
      (select count(*) from opportunities where kind = 'NO_SHOW' and status = 'won' and outcome_at >= ${monthAgo}) as no_shows,
      (select count(*) from opportunities where kind = 'STALLED_TREATMENT' and status = 'won' and outcome_at >= ${monthAgo}) as treatments,
      (select count(*) from opportunities where kind in ('LOST_LEAD', 'RECALL_DUE') and status = 'won' and outcome_at >= ${monthAgo}) as reactivated,
      (select count(*) from events where type = 'lead.escalated' and occurred_at >= ${monthAgo}) as escalations,
      (select sum(value_inr) from opportunities where status = 'won' and value_source is not null and outcome_at >= ${monthAgo}
        and (kind = 'STALLED_TREATMENT' or (kind = 'PAYMENT_FOLLOWUP' and outcome = 'balance paid'))) as known_value`)
  ).rows[0]!;

  return {
    date: today,
    today: {
      enquiries: n(t.enquiries),
      bookings: n(t.bookings),
      confirmations: n(t.confirmations),
      attended: n(t.attended),
      cancellations: n(t.cancellations),
      noShows: n(t.no_shows),
      recovered: n(t.recovered),
      followUps: n(t.follow_ups),
      escalations: n(t.escalations),
      unresolved: n(t.unresolved),
      calls: n(t.calls),
    },
    attention,
    impact: {
      days: 30,
      conversations: n(i.conversations),
      calls: n(i.calls),
      appointmentsBooked: n(i.booked),
      slotsRecovered: n(i.slots),
      noShowsRecovered: n(i.no_shows),
      treatmentsReactivated: n(i.treatments),
      patientsReactivated: n(i.reactivated),
      escalations: n(i.escalations),
      /** Clinic-entered values of reactivated treatments and balances paid in full; null = no such data. */
      knownValueInr: i.known_value === null ? null : n(i.known_value),
    },
    voiceEnabled: Boolean(config.voice?.enabled),
  };
}
