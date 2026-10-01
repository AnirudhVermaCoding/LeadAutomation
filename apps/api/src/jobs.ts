import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss, type SendOptions } from 'pg-boss';
import type { TenantTx } from './db/client.ts';

export const QUEUES = {
  firstReply: 'first-reply',
  metaLeadgen: 'meta-leadgen',
  assistantTurn: 'assistant-turn',
  appointmentNotify: 'appointment-notify',
  deadLetter: 'dead-letter',
} as const;

export interface JobData {
  [QUEUES.firstReply]: { tenantId: string; leadId: string };
  [QUEUES.metaLeadgen]: { tenantId: string; leadgenId: string; formId?: string };
  [QUEUES.assistantTurn]: { tenantId: string; leadId: string };
  [QUEUES.appointmentNotify]: {
    tenantId: string;
    appointmentId: string;
    kind: 'booked' | 'confirmed' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';
  };
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

/** pg-boss runs on the owner connection; it owns the `pgboss` schema. */
export const createBoss = (ownerUrl: string) => new PgBoss({ connectionString: ownerUrl, schema: 'pgboss' });

export async function ensureQueues(boss: PgBoss) {
  await boss.createQueue(QUEUES.deadLetter);
  for (const name of [QUEUES.firstReply, QUEUES.metaLeadgen, QUEUES.appointmentNotify])
    await boss.createQueue(name, RETRY);
  // stately + singletonKey(leadId): at most one queued and one running turn per lead, so a burst
  // of messages becomes one reply and two turns never race. Short retries: it's a live chat.
  await boss.createQueue(QUEUES.assistantTurn, {
    policy: 'stately',
    retryLimit: 3,
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
