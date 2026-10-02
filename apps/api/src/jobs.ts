import type { AppointmentNotifyKind } from './booking.ts';
import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss, type SendOptions } from 'pg-boss';
import type { TenantTx } from './db/client.ts';

export const QUEUES = {
  firstReply: 'first-reply',
  metaLeadgen: 'meta-leadgen',
  assistantTurn: 'assistant-turn',
  appointmentNotify: 'appointment-notify',
  sequenceSweep: 'sequence-sweep',
  sequenceStep: 'sequence-step',
  reportsCron: 'reports-cron',
  monitorCron: 'monitor-cron',
  maintenanceCron: 'maintenance-cron',
  webhookDeliver: 'webhook-deliver',
  staffAlert: 'staff-alert',
  calendarRemove: 'calendar-remove',
  deadLetter: 'dead-letter',
} as const;

export interface JobData {
  [QUEUES.firstReply]: { tenantId: string; leadId: string };
  [QUEUES.metaLeadgen]: { tenantId: string; leadgenId: string; formId?: string };
  [QUEUES.assistantTurn]: { tenantId: string; leadId: string };
  [QUEUES.sequenceSweep]: Record<string, never>;
  [QUEUES.sequenceStep]: { tenantId: string; stepId: string };
  [QUEUES.reportsCron]: Record<string, never>;
  [QUEUES.monitorCron]: Record<string, never>;
  [QUEUES.maintenanceCron]: Record<string, never>;
  [QUEUES.webhookDeliver]: { tenantId: string; eventId: string; endpointId: string };
  [QUEUES.staffAlert]: { tenantId: string; leadId: string; reason: string; at: string };
  [QUEUES.appointmentNotify]: {
    tenantId: string;
    appointmentId: string;
    kind: AppointmentNotifyKind;
  };
  /** Delete our events from the clinic's Google Calendar (erasure, retention). `calendarId` null = primary. */
  [QUEUES.calendarRemove]: { tenantId: string; events: { eventId: string; calendarId: string | null }[] };
}
export type QueueName = keyof JobData;

/** Failed jobs retry with exponential backoff (≈10 s → 10 min), then land in the dead-letter queue. */
const RETRY = {
  retryLimit: 6,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 600,
  deadLetter: QUEUES.deadLetter,
};

/** Assistant turns retry a few times on AI outages; the last attempt sends a holding reply instead. */
export const ASSISTANT_RETRY_LIMIT = 3;

/** pg-boss runs on the owner connection; it owns the `pgboss` schema. */
export const createBoss = (ownerUrl: string) => new PgBoss({ connectionString: ownerUrl, schema: 'pgboss' });

export async function ensureQueues(boss: PgBoss) {
  await boss.createQueue(QUEUES.deadLetter);
  // One sweep at a time (cron fires every minute).
  for (const cron of [QUEUES.sequenceSweep, QUEUES.reportsCron, QUEUES.monitorCron, QUEUES.maintenanceCron])
    await boss.createQueue(cron, { policy: 'singleton', retryLimit: 0 });
  for (const name of [
    QUEUES.firstReply,
    QUEUES.metaLeadgen,
    QUEUES.appointmentNotify,
    QUEUES.sequenceStep,
    QUEUES.webhookDeliver,
    QUEUES.staffAlert,
    QUEUES.calendarRemove,
  ])
    await boss.createQueue(name, RETRY);
  // stately + singletonKey(leadId): at most one queued and one running turn per lead, so a burst
  // of messages becomes one reply and two turns never race. Short retries: it's a live chat.
  await boss.createQueue(QUEUES.assistantTurn, {
    policy: 'stately',
    retryLimit: ASSISTANT_RETRY_LIMIT,
    retryDelay: 5,
    retryBackoff: true,
    deadLetter: QUEUES.deadLetter,
  });
}

export type Enqueue = <Q extends QueueName>(
  tx: TenantTx | null,
  queue: Q,
  data: JobData[Q],
  opts?: SendOptions,
) => Promise<void>;

/** With a `tx`, the job commits (or rolls back) together with the caller's data. */
export function createEnqueue(boss: PgBoss): Enqueue {
  return async (tx, queue, data, opts) => {
    await boss.send(queue, data, tx ? { ...opts, db: fromDrizzle(tx, sql) } : opts);
  };
}
