import type { TenantConfig } from '@instantlead/config';
import type { Clock } from '@instantlead/core';
import { desc } from 'drizzle-orm';
import { audit, type Actor } from './audit.ts';
import type { Tx } from './db/client.ts';
import { tenantConfigs } from './db/schema.ts';

export async function getActiveConfig(tx: Tx) {
  const [row] = await tx
    .select({
      revision: tenantConfigs.revision,
      config: tenantConfigs.config,
      savedAt: tenantConfigs.createdAt,
    })
    .from(tenantConfigs)
    .orderBy(desc(tenantConfigs.revision))
    .limit(1);
  return row ?? null;
}

/** Saves an already-validated config as the next revision. The unique (tenant, revision) index rejects races. */
export async function saveConfig(tx: Tx, clock: Clock, actor: Actor, config: TenantConfig) {
  const revision = ((await getActiveConfig(tx))?.revision ?? 0) + 1;
  const [row] = await tx
    .insert(tenantConfigs)
    .values({ revision, config, createdBy: actor.type === 'user' ? actor.id : null })
    .returning({ id: tenantConfigs.id });
  await audit(tx, clock, actor, {
    action: 'config.saved',
    entityType: 'tenant_config',
    entityId: row?.id,
    details: { revision },
  });
  return revision;
}
