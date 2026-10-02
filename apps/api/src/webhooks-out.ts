import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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

// Addresses a client-supplied webhook URL must never reach (SSRF): loopback, private networks,
// link-local (cloud metadata at 169.254.169.254), CGNAT, unspecified, and IPv6 equivalents.
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6');
const isPrivate = (ip: string) => {
  const mapped = /^::ffff:(d+.d+.d+.d+)$/i.exec(ip)?.[1]; // IPv4-mapped IPv6
  return mapped ? PRIVATE.check(mapped, 'ipv4') : PRIVATE.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
};

/**
 * Rejects URLs whose host is, or resolves to, a private address. Checked when the endpoint is
 * saved and again before each delivery.
 * ponytail: resolve-then-fetch leaves a DNS-rebinding window; pin the resolved IP in the request if that matters.
 */
export async function assertPublicUrl(url: string) {
  const host = new URL(url).hostname.replace(/^[|]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!ips.length || ips.some(isPrivate))
    throw new ChannelError(`Webhook host ${host} is not a public address`, { retryable: false });
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
  deps: LeadDeps & { db: Db; fetch?: typeof globalThis.fetch; allowPrivateWebhooks?: boolean },
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

  if (!deps.allowPrivateWebhooks)
    await assertPublicUrl(loaded.endpoint.url).catch(async (err: unknown) => {
      await record({ lastError: String(err instanceof Error ? err.message : err).slice(0, 300) });
      throw err;
    });
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
