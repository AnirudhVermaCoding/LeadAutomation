import {
  DEFAULT_AI_SETTINGS,
  PRESETS,
  TEMPLATE_KEYS,
  TEMPLATE_LANGUAGES,
  TEMPLATES,
  type PresetKey,
} from '@instantlead/config';
import type { Clock } from '@instantlead/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { generateApiKey, hashApiKey } from '../api-keys.ts';
import { audit, type Actor } from '../audit.ts';
import type { Db } from '../db/client.ts';
import { rulesFromBusinessHours } from '../booking.ts';
import {
  alerts,
  apiKeys,
  breachLog,
  tenantSecrets,
  availabilityRules,
  calendarLinks,
  googleConnections,
  templates,
  tenantConfigs,
  tenants,
  users,
  type UserRole,
  WEBHOOK_EVENTS,
} from '../db/schema.ts';
import type { Auth } from './auth.ts';
import { decryptSecret, encryptSecret, type SecretsKey } from '../secrets.ts';

export interface NewUser {
  email: string;
  name: string;
  password: string;
  role: UserRole;
  tenantId: string | null;
}

/** Cross-tenant operations. Everything here runs on the owner connection (no RLS). */
export function createSystem({ systemDb, auth, clock }: { systemDb: Db; auth: Auth; clock: Clock }) {
  async function createUser(u: NewUser) {
    const { user } = await auth.api.createUser({
      body: {
        email: u.email,
        name: u.name,
        password: u.password,
        role: u.role,
        data: { tenantId: u.tenantId },
      },
    });
    return user.id;
  }

  async function createApiKey(tenantId: string, name: string, actor: Actor) {
    const { key, prefix, keyHash } = generateApiKey();
    await systemDb.transaction(async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({ tenantId, name, prefix, keyHash, createdBy: actor.type === 'user' ? actor.id : null })
        .returning({ id: apiKeys.id });
      await audit(tx, clock, actor, {
        tenantId,
        action: 'api_key.created',
        entityType: 'api_key',
        entityId: row?.id,
      });
    });
    return key; // shown once; only the hash is stored
  }

  return {
    createUser,
    createApiKey,

    async resolveApiKey(key: string) {
      const [row] = await systemDb
        .update(apiKeys)
        .set({ lastUsedAt: clock.now() })
        .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
        .returning({ apiKeyId: apiKeys.id, tenantId: apiKeys.tenantId });
      return row ?? null;
    },

    async findUserIdByEmail(email: string) {
      const [row] = await systemDb
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.toLowerCase()));
      return row?.id ?? null;
    },

    listTenants() {
      return systemDb
        .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status })
        .from(tenants)
        .orderBy(tenants.name);
    },

    /** Webhook / hosted-form routing: which tenant owns this WhatsApp number, Facebook page or form? */
    async findTenantIdBy(
      field: 'waPhoneNumberId' | 'metaPageId' | 'formKey' | 'wabaId' | 'emailInKey',
      value: string,
    ) {
      const [row] = await systemDb.select({ id: tenants.id }).from(tenants).where(eq(tenants[field], value));
      return row?.id ?? null;
    },

    async getTenantRouting(tenantId: string) {
      const [row] = await systemDb
        .select({
          waPhoneNumberId: tenants.waPhoneNumberId,
          wabaId: tenants.wabaId,
          emailInKey: tenants.emailInKey,
          metaPageId: tenants.metaPageId,
          formKey: tenants.formKey,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      return row ?? null;
    },

    async setTenantRouting(
      tenantId: string,
      routing: {
        waPhoneNumberId?: string;
        wabaId?: string | null;
        metaPageId?: string;
        emailInKey?: string | null;
      },
    ) {
      await systemDb.update(tenants).set(routing).where(eq(tenants.id, tenantId));
    },

    /**
     * Claim due sequence steps across all tenants (pending and due, or stuck in 'queued' for
     * 10+ minutes after a crash). SKIP LOCKED lets several workers sweep safely.
     */
    async claimDueSteps(now: Date, limit = 200) {
      const res = await systemDb.execute<{ id: string; tenant_id: string }>(sql`
        update enrollment_steps set status = 'queued', attempts = attempts + 1, updated_at = now()
        where id in (
          select id from enrollment_steps
          where (status = 'pending' and due_at <= ${now})
             or (status = 'queued' and updated_at < now() - interval '10 minutes')
          order by due_at
          limit ${limit}
          for update skip locked
        )
        returning id, tenant_id`);
      return res.rows.map((r) => ({ stepId: r.id, tenantId: r.tenant_id }));
    },

    /** Webhook routing: which tenant's calendar link owns this Google push channel? */
    async findCalendarChannel(channelId: string) {
      const [row] = await systemDb
        .select({ tenantId: calendarLinks.tenantId, linkId: calendarLinks.id })
        .from(calendarLinks)
        .where(eq(calendarLinks.channelId, channelId));
      return row ?? null;
    },

    /** Every busy-source calendar of every connected (not reauth_needed) tenant, for the sync sweep. */
    async calendarLinksForSweep() {
      return systemDb
        .select({
          tenantId: calendarLinks.tenantId,
          linkId: calendarLinks.id,
          lastSyncedAt: calendarLinks.lastSyncedAt,
          lastFullSyncAt: calendarLinks.lastFullSyncAt,
          channelId: calendarLinks.channelId,
          channelExpiresAt: calendarLinks.channelExpiresAt,
        })
        .from(calendarLinks)
        .leftJoin(googleConnections, eq(googleConnections.tenantId, calendarLinks.tenantId))
        .where(
          and(
            eq(calendarLinks.readBusy, true),
            sql`coalesce(${googleConnections.status}, 'ok') <> 'reauth_needed'`,
          ),
        );
    },

    /** Agency view: per-tenant volume and running costs since `since` (protects margin). */
    async usageSince(since: Date) {
      const res = await systemDb.execute<{
        id: string;
        name: string;
        slug: string;
        leads: string;
        messages_out: string;
        whatsapp_inr: string;
        llm_usd: string;
        llm_cap_usd: string;
        llm_providers: string;
        bookings: string;
      }>(sql`
        select t.id, t.name, t.slug,
          (select count(*) from leads l where l.tenant_id = t.id and l.received_at >= ${since}) as leads,
          (select count(*) from messages m where m.tenant_id = t.id and m.direction = 'out'
             and m.status in ('sent', 'delivered', 'read') and m.occurred_at >= ${since}) as messages_out,
          (select coalesce(sum(m.est_cost_inr), 0) from messages m where m.tenant_id = t.id
             and m.status in ('sent', 'delivered', 'read') and m.occurred_at >= ${since}) as whatsapp_inr,
          (select coalesce(sum(r.cost_usd), 0) from llm_runs r
             where r.tenant_id = t.id and r.occurred_at >= ${since}) as llm_usd,
          coalesce((select (c.config->'ai'->>'monthly_cost_cap_usd')::numeric from tenant_configs c
             where c.tenant_id = t.id order by c.revision desc limit 1), ${DEFAULT_AI_SETTINGS.monthly_cost_cap_usd}) as llm_cap_usd,
          (select coalesce(string_agg(distinct r.provider, ', '), '') from llm_runs r
             where r.tenant_id = t.id and r.occurred_at >= ${since}) as llm_providers,
          (select count(*) from appointments a where a.tenant_id = t.id and a.status <> 'cancelled'
             and a.created_at >= ${since}) as bookings
        from tenants t
        order by t.name`);
      return res.rows.map((r) => ({
        tenantId: r.id,
        name: r.name,
        slug: r.slug,
        leads: Number(r.leads),
        messagesOut: Number(r.messages_out),
        whatsappInr: Number(r.whatsapp_inr),
        llmUsd: Number(r.llm_usd),
        llmCapUsd: Number(r.llm_cap_usd),
        llmProviders: r.llm_providers,
        bookings: Number(r.bookings),
      }));
    },

    /**
     * Outbound-webhook outbox: claim subscribed events not yet fanned out (one pass marks them
     * dispatched, SKIP LOCKED for concurrent sweeps) and return the endpoints to deliver to.
     */
    async claimWebhookEvents(limit = 500) {
      const res = await systemDb.execute<{ tenant_id: string; id: string; endpoint_ids: string[] }>(sql`
        with due as (
          select e.id from events e
          where e.webhook_dispatched_at is null
            and e.type in (${sql.join(
              WEBHOOK_EVENTS.map((t) => sql`${t}`),
              sql`, `,
            )})
          order by e.occurred_at
          limit ${limit}
          for update skip locked
        )
        update events e set webhook_dispatched_at = now()
        from due where e.id = due.id
        returning e.tenant_id, e.id, array(
          select w.id from webhook_endpoints w
          where w.tenant_id = e.tenant_id and w.active and w.events ? e.type
        ) as endpoint_ids`);
      return res.rows
        .filter((r) => r.endpoint_ids.length)
        .map((r) => ({ tenantId: r.tenant_id, eventId: r.id, endpointIds: r.endpoint_ids }));
    },

    /** Re-encrypt every tenant secret with the current key (after setting SECRETS_KEY_PREVIOUS). */
    async rotateSecrets(keys: SecretsKey) {
      const rows = await systemDb.select().from(tenantSecrets);
      for (const r of rows) {
        const plain = decryptSecret(keys, r.tenantId, r.name, r.valueEnc);
        await systemDb
          .update(tenantSecrets)
          .set({ valueEnc: encryptSecret(keys, r.tenantId, r.name, plain) })
          .where(eq(tenantSecrets.id, r.id));
      }
      return rows.length;
    },

    /** Agency: the DPDP breach register. */
    listBreaches() {
      return systemDb.select().from(breachLog).orderBy(desc(breachLog.detectedAt)).limit(200);
    },
    async recordBreach(b: typeof breachLog.$inferInsert) {
      const [row] = await systemDb.insert(breachLog).values(b).returning();
      return row;
    },

    /** Tenants with a WhatsApp Business Account id (the daily template sync). */
    async tenantsWithWaba() {
      return systemDb
        .select({ id: tenants.id })
        .from(tenants)
        .where(sql`${tenants.wabaId} is not null`);
    },

    /** Cross-tenant health signals for the agency monitor (real time, DB clock). */
    async monitorSignals() {
      const rows = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await systemDb.execute<T>(q)).rows;
      return {
        failedSends: await rows<{ tenant_id: string; name: string; n: string }>(sql`
          select m.tenant_id, t.name, count(*) as n from messages m join tenants t on t.id = m.tenant_id
          where m.direction = 'out' and m.status = 'failed' and m.updated_at > now() - interval '1 hour'
          group by m.tenant_id, t.name having count(*) >= 3`),
        llmErrors: await rows<{ tenant_id: string; name: string; n: string }>(sql`
          select r.tenant_id, t.name, count(*) as n from llm_runs r join tenants t on t.id = r.tenant_id
          where r.error is not null and r.created_at > now() - interval '1 hour'
          group by r.tenant_id, t.name having count(*) >= 5`),
        // Live WhatsApp sends but no delivery receipt for an hour: the webhook is probably not reaching us.
        noReceipts: await rows<{ tenant_id: string; name: string; n: string }>(sql`
          select m.tenant_id, t.name, count(*) as n from messages m join tenants t on t.id = m.tenant_id
          where m.provider = 'meta' and m.direction = 'out' and m.created_at > now() - interval '24 hours'
          group by m.tenant_id, t.name
          having count(*) filter (where m.status in ('delivered', 'read')) = 0
             and min(m.created_at) < now() - interval '1 hour'`),
        // This month's AI spend at or above 80% of the tenant's cap (config ai.monthly_cost_cap_usd).
        aiBudget: await rows<{ tenant_id: string; name: string; spend: string; cap: string }>(sql`
          select * from (
            select t.id as tenant_id, t.name,
              (select coalesce(sum(r.cost_usd), 0) from llm_runs r
                 where r.tenant_id = t.id and r.occurred_at >= date_trunc('month', now())) as spend,
              coalesce((select (c.config->'ai'->>'monthly_cost_cap_usd')::numeric from tenant_configs c
             where c.tenant_id = t.id order by c.revision desc limit 1), ${DEFAULT_AI_SETTINGS.monthly_cost_cap_usd}) as cap
            from tenants t) x
          where x.cap > 0 and x.spend >= 0.8 * x.cap`),
        // Google was disconnected behind our back (revoked, expired, 7-day testing limit): bookings stop syncing.
        googleReauth: await rows<{ tenant_id: string; name: string }>(sql`
          select g.tenant_id, t.name from google_connections g join tenants t on t.id = g.tenant_id
          where g.status = 'reauth_needed'`),
        // A template that was approved is now paused / disabled / flagged by Meta: sends using it will fail.
        templatesBlocked: await rows<{ tenant_id: string; name: string; n: string; keys: string }>(sql`
          select tp.tenant_id, t.name, count(*) as n, string_agg(distinct tp.key, ', ') as keys
          from templates tp join tenants t on t.id = tp.tenant_id
          where tp.provider_status in ('PAUSED', 'DISABLED', 'FLAGGED', 'LOCKED')
          group by tp.tenant_id, t.name`),
        // A calendar that should be syncing hasn't for 30+ minutes: busy time may be stale.
        calendarStale: await rows<{ tenant_id: string; name: string; n: string }>(sql`
          select l.tenant_id, t.name, count(*) as n from calendar_links l join tenants t on t.id = l.tenant_id
          left join google_connections g on g.tenant_id = l.tenant_id
          where l.read_busy and coalesce(g.status, 'ok') = 'ok'
            and coalesce(l.last_synced_at, l.created_at) < now() - interval '30 minutes'
          group by l.tenant_id, t.name`),
        backlog: Number(
          (
            await rows<{ n: string }>(sql`
            select count(*) as n from pgboss.job where state = 'created' and start_after < now() - interval '10 minutes'`)
          )[0]?.n ?? 0,
        ),
        deadLetters: Number(
          (
            await rows<{ n: string }>(sql`
            select count(*) as n from pgboss.job where name = 'dead-letter' and created_on > now() - interval '1 hour'`)
          )[0]?.n ?? 0,
        ),
      };
    },

    /** Upsert an alert; true when it should be (re)sent (first time, or quiet for 6 h). */
    async raiseAlert(a: { key: string; tenantId: string | null; kind: string; message: string; now: Date }) {
      const [row] = await systemDb
        .insert(alerts)
        .values({ key: a.key, tenantId: a.tenantId, kind: a.kind, message: a.message, lastSeenAt: a.now })
        .onConflictDoUpdate({ target: alerts.key, set: { message: a.message, lastSeenAt: a.now } })
        .returning({ id: alerts.id, lastSentAt: alerts.lastSentAt });
      if (!row || (row.lastSentAt && a.now.getTime() - row.lastSentAt.getTime() < 6 * 3_600_000))
        return false;
      await systemDb.update(alerts).set({ lastSentAt: a.now }).where(eq(alerts.id, row.id));
      return true;
    },

    recentAlerts() {
      return systemDb.select().from(alerts).orderBy(desc(alerts.lastSeenAt)).limit(50);
    },

    /** Jobs that exhausted their retries (agency view). */
    async deadLetters(limit = 50) {
      return (
        await systemDb.execute<{
          id: string;
          source_name: string | null;
          data: unknown;
          source_output: unknown;
          created_on: Date;
        }>(sql`
          select id, source_name, data, source_output, created_on from pgboss.job where name = 'dead-letter'
          order by created_on desc limit ${limit}`)
      ).rows;
    },

    async getDeadLetter(id: string) {
      const rows = (
        await systemDb.execute<{ id: string; source_name: string | null; data: unknown }>(sql`
          select id, source_name, data from pgboss.job where name = 'dead-letter' and id = ${id}`)
      ).rows;
      return rows[0] ?? null;
    },

    async findTenantBySlug(slug: string) {
      const [row] = await systemDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
      return row ?? null;
    },

    /** Clone a preset into a new tenant (config revision 1), optionally with its first client_admin. */
    async createTenant(
      input: { slug: string; name: string; preset: PresetKey; admin?: Omit<NewUser, 'role' | 'tenantId'> },
      actor: Actor,
    ) {
      const tenant = await systemDb.transaction(async (tx) => {
        const [t] = await tx.insert(tenants).values({ slug: input.slug, name: input.name }).returning();
        if (!t) throw new Error('tenant insert failed');
        const config = PRESETS[input.preset](input.name);
        // Bookable hours start as the business hours (one resource); editable later.
        await tx
          .insert(availabilityRules)
          .values(rulesFromBusinessHours(config).map((r) => ({ ...r, tenantId: t.id })));
        await tx.insert(tenantConfigs).values({
          tenantId: t.id,
          revision: 1,
          config,
          createdBy: actor.type === 'user' ? actor.id : null,
        });
        // Every registry template, both languages, starts as a draft the client must get approved.
        await tx.insert(templates).values(
          TEMPLATE_KEYS.flatMap((key) =>
            TEMPLATE_LANGUAGES.map((language) => ({
              tenantId: t.id,
              key,
              language,
              providerName: TEMPLATES[key].providerName,
              category: TEMPLATES[key].category,
            })),
          ),
        );
        await audit(tx, clock, actor, {
          tenantId: t.id,
          action: 'tenant.created',
          entityType: 'tenant',
          entityId: t.id,
          details: { preset: input.preset },
        });
        return t;
      });
      const adminUserId = input.admin
        ? await createUser({ ...input.admin, role: 'client_admin', tenantId: tenant.id })
        : null;
      return { tenant, adminUserId };
    },
  };
}

export type System = ReturnType<typeof createSystem>;
