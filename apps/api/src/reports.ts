import type { TenantConfig } from '@instantlead/config';
import { addDays, localParts, zonedTimeToUtc } from '@instantlead/core';
import type { EmailProvider } from '@instantlead/integrations';
import { desc, eq, sql } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Db, type Tx } from './db/client.ts';
import { reports, type ReportData } from './db/schema.ts';
import type { LeadDeps } from './leads.ts';

/** What leads ask about, by keyword group (deterministic, no LLM). */
const TOPICS: [string, RegExp][] = [
  ['Prices', /\b(price|cost|fee|charges?|how much|kitna|kitne|rate)\b|₹/i],
  ['Availability / timings', /\b(timing|open|close|hours|today|tomorrow|slot|available|kab)\b/i],
  ['Location / parking', /\b(address|where|location|kahan|parking|map|directions)\b/i],
  ['Doctors', /\b(doctor|dr|dentist|specialist|surgeon)\b/i],
  ['Pain / urgent', /\b(pain|dard|urgent|emergency|swelling|bleeding)\b/i],
  ['Insurance / payment', /\b(insurance|emi|card|upi|cash|payment)\b/i],
];

const n = (v: unknown) => Number(v ?? 0);
const one = async <T>(tx: Tx, query: ReturnType<typeof sql>) =>
  (await tx.execute<T & Record<string, unknown>>(query)).rows[0]!;

/**
 * The numbers for [start, end), all from the database and all on business-clock timestamps
 * (received_at, occurred_at, starts_at), so fast-forwarded demos report correctly too.
 */
export async function computeReport(
  tx: Tx,
  config: TenantConfig,
  start: Date,
  end: Date,
  now: Date,
): Promise<ReportData> {
  const tz = config.locale.timezone;
  const leadsRow = await one<{ leads: string; replied: string; qualified: string; median: string | null }>(
    tx,
    sql`
      select count(*) as leads,
        count(*) filter (where exists (select 1 from messages m where m.lead_id = l.id and m.direction = 'in')) as replied,
        count(*) filter (where l.tier is not null) as qualified,
        percentile_cont(0.5) within group (order by extract(epoch from fr.first_out - l.received_at)) as median
      from leads l
      left join lateral (
        select min(m.occurred_at) as first_out from messages m
        where m.lead_id = l.id and m.direction = 'out' and m.status in ('sent', 'delivered', 'read')
      ) fr on true
      where l.received_at >= ${start} and l.received_at < ${end}`,
  );
  const booked = await one<{ c: string }>(
    tx,
    sql`select count(*) as c from events where type = 'appointment.booked' and occurred_at >= ${start} and occurred_at < ${end}`,
  );
  const visits = await one<{ shows: string; no_shows: string; upcoming: string }>(
    tx,
    sql`
      select count(*) filter (where status = 'completed' and starts_at >= ${start} and starts_at < ${end}) as shows,
        count(*) filter (where status = 'no_show' and starts_at >= ${start} and starts_at < ${end}) as no_shows,
        count(*) filter (where status in ('pending', 'scheduled', 'confirmed') and starts_at >= ${now}) as upcoming
      from appointments`,
  );
  const inbound = (
    await tx.execute<{ body: string }>(
      sql`select body from messages where direction = 'in' and occurred_at >= ${start} and occurred_at < ${end} limit 5000`,
    )
  ).rows;
  const monthStart = zonedTimeToUtc(`${localParts(end, tz).date.slice(0, 8)}01`, '00:00', tz);
  const costs = await one<{ whatsapp: string; llm: string }>(
    tx,
    sql`
      select
        (select coalesce(sum(est_cost_inr), 0) from messages where status in ('sent', 'delivered', 'read')
           and occurred_at >= ${monthStart} and occurred_at < ${end}) as whatsapp,
        (select coalesce(sum(cost_usd), 0) from llm_runs where occurred_at >= ${monthStart} and occurred_at < ${end}) as llm`,
  );

  const leadCount = n(leadsRow.leads);
  const shows = n(visits.shows);
  const noShows = n(visits.no_shows);
  const counts = new Map<string, number>();
  for (const { body } of inbound)
    for (const [topic, re] of TOPICS) if (re.test(body)) counts.set(topic, (counts.get(topic) ?? 0) + 1);

  return {
    period: {
      start: start.toISOString(),
      end: end.toISOString(),
      label: `${localParts(start, tz).date} to ${localParts(new Date(end.getTime() - 1), tz).date}`,
    },
    leads: leadCount,
    medianFirstResponseSec: leadsRow.median === null ? null : Math.round(Number(leadsRow.median)),
    repliedLeads: n(leadsRow.replied),
    replyRate: leadCount ? n(leadsRow.replied) / leadCount : null,
    qualified: n(leadsRow.qualified),
    booked: n(booked.c),
    shows,
    noShows,
    showRate: shows + noShows ? shows / (shows + noShows) : null,
    revenueRecoveredInr: shows * config.reports.avg_transaction_value,
    upcomingBookings: n(visits.upcoming),
    topTopics: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count })),
    costs: { monthStart: monthStart.toISOString(), whatsappInr: n(costs.whatsapp), llmUsd: n(costs.llm) },
  };
}

const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const duration = (s: number | null) =>
  s === null ? '—' : s < 90 ? `${s} seconds` : `${Math.round(s / 60)} minutes`;

export function renderReportEmail(businessName: string, r: ReportData) {
  const lines: [string, string][] = [
    ['New enquiries', String(r.leads)],
    ['Median time to first reply', duration(r.medianFirstResponseSec)],
    ['Leads who replied', `${r.repliedLeads} (${pct(r.replyRate)})`],
    ['Qualified', String(r.qualified)],
    ['Appointments booked', String(r.booked)],
    ['Visits completed / no-shows', `${r.shows} / ${r.noShows} (show rate ${pct(r.showRate)})`],
    ['Estimated revenue from completed visits', inr(r.revenueRecoveredInr)],
    ['Upcoming booked appointments', String(r.upcomingBookings)],
    [
      'Running cost this month (WhatsApp + AI)',
      `${inr(r.costs.whatsappInr)} + $${r.costs.llmUsd.toFixed(2)}`,
    ],
  ];
  const topics = r.topTopics.length ? r.topTopics.map((t) => `${t.topic} (${t.count})`).join(', ') : '—';
  const subject = `${businessName}: your week in leads (${r.period.label})`;
  const text = [
    `${businessName} — weekly report, ${r.period.label}`,
    '',
    ...lines.map(([k, v]) => `${k}: ${v}`),
    `What people asked about: ${topics}`,
    '',
    'Numbers are counted from your InstantLead records. Revenue is completed visits × your average visit value.',
  ].join('\n');
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 4px">${esc(businessName)}</h2><p style="margin:0 0 16px;color:#64748b">Weekly report · ${esc(r.period.label)}</p>
<table style="width:100%;border-collapse:collapse">${lines
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #e2e8f0;color:#475569">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600">${esc(v)}</td></tr>`,
    )
    .join('')}</table>
<p style="color:#475569">What people asked about: ${esc(topics)}</p>
<p style="color:#94a3b8;font-size:12px">Numbers are counted from your InstantLead records. Revenue is completed visits × your average visit value.</p></div>`;
  return { subject, text, html };
}

/** The 7 tenant-local days that ended at local midnight today. */
export function lastWeek(now: Date, tz: string) {
  const end = zonedTimeToUtc(localParts(now, tz).date, '00:00', tz);
  return { start: zonedTimeToUtc(addDays(localParts(end, tz).date, -7), '00:00', tz), end };
}

/**
 * Hourly (and on demo fast-forward): on each tenant's report day from 09:00 local, build last
 * week's report once (unique per period), store it, and email it to the configured recipients.
 */
export async function runScheduledReports(
  deps: LeadDeps & { db: Db; email: EmailProvider; system: { listTenants(): Promise<{ id: string }[]> } },
) {
  const now = deps.clock.now();
  const sent: string[] = [];
  for (const { id: tenantId } of await deps.system.listTenants()) {
    const due = await withTenant(deps.db, tenantId, async (tx) => {
      const config = (await getActiveConfig(tx))?.config;
      if (!config) return null;
      const local = localParts(now, config.locale.timezone);
      if (local.weekday !== config.reports.weekly_day || local.time < '09:00') return null;
      const { start, end } = lastWeek(now, config.locale.timezone);
      const data = await computeReport(tx, config, start, end, now);
      const [row] = await tx
        .insert(reports)
        .values({ periodStart: start, periodEnd: end, data })
        .onConflictDoNothing({ target: [reports.tenantId, reports.periodStart] })
        .returning({ id: reports.id });
      return row ? { id: row.id, config, data } : null;
    });
    if (!due) continue;
    const to = due.config.reports.send_to;
    let error: string | null = null;
    try {
      if (to.length)
        await deps.email.send({
          to,
          ...renderReportEmail(due.config.brand.business_name, due.data),
          idempotencyKey: `report:${due.id}`,
        });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(reports)
        .set({ sentTo: to, sentAt: error ? null : deps.clock.now(), error })
        .where(eq(reports.id, due.id)),
    );
    sent.push(tenantId);
  }
  return sent;
}

export const listReports = (tx: Tx) => tx.select().from(reports).orderBy(desc(reports.periodStart)).limit(52);
