import { TEMPLATE_LANGUAGES, type TemplateLanguage } from '@instantlead/config';
import type { Clock } from '@instantlead/core';
import { listMessageTemplates } from '@instantlead/integrations';
import { and, eq } from 'drizzle-orm';
import { withTenant, type Db, type Tx } from './db/client.ts';
import { templates } from './db/schema.ts';
import type { JobData } from './jobs.ts';
import { getTenantSecret, type SecretsKey } from './secrets.ts';

type OurStatus = 'approved' | 'submitted' | 'rejected';

/** Meta statuses/events that let us send, are still in review, or block sending (everything else). */
const STATUS: Record<string, OurStatus> = {
  APPROVED: 'approved',
  REINSTATED: 'approved',
  UNARCHIVED: 'approved',
  PENDING: 'submitted',
  IN_APPEAL: 'submitted',
};
export const statusOf = (metaStatus: string): OurStatus => STATUS[metaStatus.toUpperCase()] ?? 'rejected';

/** Statuses that mean a template that worked is now unusable (alert the agency). */
export const BLOCKING_PROVIDER_STATUSES = ['PAUSED', 'DISABLED', 'FLAGGED', 'LOCKED'];

/** `en_US`, `en-GB`, `hi` → our `en` / `hi`; anything else is not one of ours. */
export function languageOf(code: string): TemplateLanguage | null {
  const base = code.toLowerCase().slice(0, 2);
  return (TEMPLATE_LANGUAGES as readonly string[]).includes(base) ? (base as TemplateLanguage) : null;
}

const categoryOf = (c: string | undefined) =>
  c?.toUpperCase() === 'MARKETING' ? 'marketing' : c?.toUpperCase() === 'UTILITY' ? 'utility' : undefined;

/** Apply what Meta says about templates (a list or one webhook) to this tenant's rows, matched by Meta name + language. */
export async function applyTemplateStatuses(
  tx: Tx,
  clock: Pick<Clock, 'now'>,
  rows: {
    name: string;
    language: string;
    status: string;
    category?: string | undefined;
    reason?: string | undefined;
  }[],
) {
  let updated = 0;
  for (const r of rows) {
    const language = languageOf(r.language);
    if (!language) continue;
    const category = categoryOf(r.category);
    const res = await tx
      .update(templates)
      .set({
        status: statusOf(r.status),
        providerStatus: r.status.toUpperCase(),
        statusReason: r.reason ?? null,
        syncedAt: clock.now(),
        ...(category ? { category } : {}),
      })
      .where(and(eq(templates.providerName, r.name), eq(templates.language, language)))
      .returning({ id: templates.id });
    updated += res.length;
  }
  return updated;
}

export interface TemplateSyncDeps {
  db: Db;
  clock: Clock;
  secretsKey: SecretsKey;
  fetch?: typeof globalThis.fetch | undefined;
  system: { getTenantRouting(tenantId: string): Promise<{ wabaId: string | null } | null> };
}

/** Pull every template's status from Meta (daily, on demand, and when the WABA id is first saved). */
export async function syncTemplates(deps: TemplateSyncDeps, { tenantId }: JobData['template-sync']) {
  const routing = await deps.system.getTenantRouting(tenantId);
  if (!routing?.wabaId) return { skipped: 'no WhatsApp Business Account id' };
  const token = await withTenant(deps.db, tenantId, (tx) =>
    getTenantSecret(tx, deps.secretsKey, tenantId, 'whatsapp_access_token'),
  );
  if (!token) return { skipped: 'WhatsApp not connected' };
  const list = await listMessageTemplates({ wabaId: routing.wabaId, accessToken: token, fetch: deps.fetch });
  const updated = await withTenant(deps.db, tenantId, (tx) => applyTemplateStatuses(tx, deps.clock, list));
  return { listed: list.length, updated };
}
