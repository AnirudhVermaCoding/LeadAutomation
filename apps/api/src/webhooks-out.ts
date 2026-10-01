import { createHmac, randomBytes } from 'node:crypto';
import { ChannelError } from '@instantlead/integrations';
import { eq } from 'drizzle-orm';
import { withTenant, type Db } from './db/client.ts';
import { events, leads, webhookEndpoints } from './db/schema.ts';
import { QUEUES, type Enqueue } from './jobs.ts';
import type { LeadDeps } from './leads.ts';
import { getTenantSecret } from './secrets.ts';

export const webhookSecretName = (endpointId: string) => `webhook:${endpointId}`;
export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/**
 * Signature the receiver verifies: header `x-instantlead-signature: t=<unix>,v1=<hex>` where
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Including t lets them reject replays.
 */
export function signWebhook(secret: string, body: string, unixSeconds: number) {
  const v1 = createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex');
  return `t=${unixSeconds},v1=${v1}`;
}

/** Per-minute outbox sweep: fan new subscribed events out to delivery jobs (one per endpoint). */
export async function dispatchWebhookEvents(deps: {
  enqueue: Enqueue;
  system: { claimWebhookEvents(): Promise<{ tenantId: string; eventId: string; endpointIds: string[] }[]> };
}) {
  const claimed = await deps.system.claimWebhookEvents();
  for (const c of claimed)
    for (const endpointId of c.endpointIds)
      await deps.enqueue(null, QUEUES.webhookDeliver, {
        tenantId: c.tenantId,
        eventId: c.eventId,
        endpointId,
      });
  return claimed.length;
}

/** POST one event to one endpoint. 5xx / network errors retry (pg-boss backoff); 4xx are final. */
export async function deliverWebhook(
  deps: LeadDeps & { db: Db; fetch?: typeof globalThis.fetch },
  job: { tenantId: string; eventId: string; endpointId: string },
) {
  const { tenantId, eventId, endpointId } = job;
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const [endpoint] = await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId));
    const [event] = await tx.select().from(events).where(eq(events.id, eventId));
    const secret = await getTenantSecret(tx, deps.secretsKey, tenantId, webhookSecretName(endpointId));
    // Lead details are read now, not stored in the event: an erased lead sends ids only.
    const leadId = typeof event?.payload.leadId === 'string' ? event.payload.leadId : null;
    const [lead] = leadId
      ? await tx
          .select({
            id: leads.id,
            name: leads.name,
            phone: leads.phoneE164,
            email: leads.email,
            state: leads.state,
            tier: leads.tier,
            source: leads.source,
          })
          .from(leads)
          .where(eq(leads.id, leadId))
      : [];
    return endpoint?.active && event && secret ? { endpoint, event, secret, lead: lead ?? null } : null;
  });
  if (!loaded) return { skipped: 'endpoint or event gone' };

  const body = JSON.stringify({
    id: loaded.event.id,
    type: loaded.event.type,
    occurred_at: loaded.event.occurredAt.toISOString(),
    data: { ...loaded.event.payload, lead: loaded.lead },
  });
  const record = (fields: Partial<typeof webhookEndpoints.$inferInsert>) =>
    withTenant(deps.db, tenantId, (tx) =>
      tx.update(webhookEndpoints).set(fields).where(eq(webhookEndpoints.id, endpointId)),
    );

  let res: Response;
  try {
    res = await (deps.fetch ?? globalThis.fetch)(loaded.endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'InstantLead-Webhooks/1',
        'x-instantlead-event': loaded.event.type,
        'x-instantlead-signature': signWebhook(
          loaded.secret,
          body,
          Math.floor(deps.clock.now().getTime() / 1000),
        ),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    await record({ lastError: String(err).slice(0, 300) });
    throw new ChannelError(`Webhook delivery failed: ${String(err)}`, { retryable: true });
  }
  if (res.ok) {
    await record({ lastStatus: res.status, lastError: null, lastDeliveredAt: deps.clock.now() });
    return { status: res.status };
  }
  await record({ lastStatus: res.status, lastError: `HTTP ${res.status}` });
  throw new ChannelError(`Webhook endpoint answered HTTP ${res.status}`, {
    retryable: res.status >= 500 || res.status === 429,
  });
}
