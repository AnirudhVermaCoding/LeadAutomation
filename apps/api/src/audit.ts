import type { Clock } from '@instantlead/core';
import type { Tx } from './db/client.ts';
import { auditLog } from './db/schema.ts';

export type Actor = { type: 'user' | 'api_key'; id: string } | { type: 'system'; id?: undefined };

/**
 * Record a config change or human action. Pass IDs and field names only — never PII.
 * Inside withTenant() the tenant is implicit; system code (no RLS context) passes `tenantId`.
 */
export async function audit(
  tx: Tx,
  clock: Clock,
  actor: Actor,
  entry: {
    action: string;
    entityType: string;
    entityId?: string;
    details?: Record<string, unknown>;
    tenantId?: string;
  },
) {
  await tx
    .insert(auditLog)
    .values({ ...entry, actorType: actor.type, actorId: actor.id, occurredAt: clock.now() });
}
