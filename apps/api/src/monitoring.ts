import type { EmailProvider } from '@instantlead/integrations';
import { sql } from 'drizzle-orm';
import type { Tx } from './db/client.ts';
import type { System } from './system/index.ts';

/**
 * Every 5 minutes: look for trouble across all tenants and email the agency (deduped: an alert
 * is re-sent at most every 6 hours while it persists). Returns what was found.
 */
export async function runMonitor(deps: {
  system: System;
  email: EmailProvider;
  alertEmail?: string | undefined;
  /** Also tell the agency on WhatsApp (their own number): one short line per run. */
  whatsapp?: ((note: string) => Promise<void>) | null | undefined;
  now: () => Date;
}) {
  const s = await deps.system.monitorSignals();
  const found: { key: string; tenantId: string | null; kind: string; message: string }[] = [
    ...s.failedSends.map((r) => ({
      key: `failed_sends:${r.tenant_id}`,
      tenantId: r.tenant_id,
      kind: 'failed_sends',
      message: `${r.name}: ${r.n} WhatsApp sends failed in the last hour.`,
    })),
    ...s.llmErrors.map((r) => ({
      key: `llm_errors:${r.tenant_id}`,
      tenantId: r.tenant_id,
      kind: 'llm_errors',
      message: `${r.name}: ${r.n} assistant (LLM) errors in the last hour; conversations are being handed to staff.`,
    })),
    ...s.noReceipts.map((r) => ({
      key: `no_receipts:${r.tenant_id}`,
      tenantId: r.tenant_id,
      kind: 'webhook_silent',
      message: `${r.name}: ${r.n} WhatsApp messages sent but no delivery receipts for over an hour. Check the Meta webhook.`,
    })),
    ...s.googleReauth.map((r) => ({
      key: `google_reauth:${r.tenant_id}`,
      tenantId: r.tenant_id,
      kind: 'google_reauth',
      message: `${r.name}: Google Calendar access was revoked or expired. Bookings are not syncing until an admin reconnects Google (Settings → Integrations).`,
    })),
    ...s.templatesBlocked.map((r) => ({
      key: `templates_blocked:${r.tenant_id}`,
      tenantId: r.tenant_id,
      kind: 'templates_blocked',
      message: `${r.name}: Meta paused or disabled ${r.n} WhatsApp template(s) (${r.keys}). Messages using them fail until they are fixed in WhatsApp Manager.`,
    })),
    ...s.calendarStale.map((r) => ({
      key: `calendar_stale:${r.tenant_id}`,
      tenantId: r.tenant_id,
      kind: 'calendar_stale',
      message: `${r.name}: ${r.n} Google calendar(s) have not synced for 30+ minutes; busy time from Google may be out of date.`,
    })),
    ...(s.backlog > 50
      ? [
          {
            key: 'queue_backlog',
            tenantId: null,
            kind: 'queue_backlog',
            message: `${s.backlog} jobs waiting over 10 minutes: are the workers running?`,
          },
        ]
      : []),
    ...(s.deadLetters > 0
      ? [
          {
            key: 'dead_letters',
            tenantId: null,
            kind: 'dead_letters',
            message: `${s.deadLetters} jobs failed permanently in the last hour (see Agency → Monitoring).`,
          },
        ]
      : []),
  ];

  const toSend: string[] = [];
  for (const r of s.aiBudget) {
    const pct = Math.round((Number(r.spend) / Number(r.cap)) * 100);
    found.push({
      key: `ai_budget:${r.tenant_id}:${pct >= 100 ? 'over' : 'warn'}`,
      tenantId: r.tenant_id,
      kind: 'ai_budget',
      message:
        pct >= 100
          ? `${r.name}: AI budget used up ($${Number(r.spend).toFixed(2)} of $${Number(r.cap)}). New conversations go to staff until next month or a higher cap.`
          : `${r.name}: ${pct}% of this month's AI budget used ($${Number(r.spend).toFixed(2)} of $${Number(r.cap)}).`,
    });
  }
  for (const a of found) if (await deps.system.raiseAlert({ ...a, now: deps.now() })) toSend.push(a.message);
  if (toSend.length && deps.alertEmail)
    await deps.email.send({
      to: [deps.alertEmail],
      subject: `InstantLead alert: ${toSend.length} issue${toSend.length > 1 ? 's' : ''}`,
      text: `${toSend.map((m) => `• ${m}`).join('\n')}\n\nOpen the Agency page for details.`,
    });
  if (toSend.length && deps.whatsapp)
    await deps
      .whatsapp(
        toSend.length === 1
          ? toSend[0]!.slice(0, 200)
          : `${toSend.length} issues, e.g. ${toSend[0]!.slice(0, 120)}`,
      )
      .catch(() => undefined); // email is the record; never fail the monitor over WhatsApp
  return { found: found.length, emailed: toSend.length };
}

/** Settings → Integrations status panel, derived from what actually happened (no separate state to drift). */
export async function integrationHealth(tx: Tx) {
  const [row] = (
    await tx.execute<{
      last_sent: Date | null;
      last_receipt: Date | null;
      last_inbound: Date | null;
      failed_24h: string;
      llm_errors_24h: string;
      last_llm_ok: Date | null;
    }>(sql`
      select
        (select max(occurred_at) from messages where direction = 'out' and status in ('sent', 'delivered', 'read')) as last_sent,
        (select max(updated_at) from messages where direction = 'out' and status in ('delivered', 'read')) as last_receipt,
        (select max(occurred_at) from messages where direction = 'in') as last_inbound,
        (select count(*) from messages where direction = 'out' and status = 'failed' and updated_at > now() - interval '24 hours') as failed_24h,
        (select count(*) from llm_runs where error is not null and created_at > now() - interval '24 hours') as llm_errors_24h,
        (select max(occurred_at) from llm_runs where error is null) as last_llm_ok`)
  ).rows;
  return {
    lastSuccessfulSend: row?.last_sent ?? null,
    lastDeliveryReceipt: row?.last_receipt ?? null,
    lastInboundMessage: row?.last_inbound ?? null,
    failedSends24h: Number(row?.failed_24h ?? 0),
    llmErrors24h: Number(row?.llm_errors_24h ?? 0),
    lastAssistantReply: row?.last_llm_ok ?? null,
  };
}
