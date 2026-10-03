import { LANGUAGES, type TenantConfig } from '@instantlead/config';
import { LEAD_STATES, TIERS } from '@instantlead/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Runtime role used by the app; RLS applies to it. Created by db/migrate.ts, not by drizzle-kit. */
export const APP_ROLE = 'instantlead_app';
export const appRole = pgRole(APP_ROLE).existing();

/** The tenant set by withTenant() for the current transaction; NULL when unset (fails closed). */
export const currentTenant = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;

/** RLS policy for every tenant-scoped table. */
const tenantScoped = () =>
  pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    to: appRole,
    using: sql`tenant_id = ${currentTenant}`,
    withCheck: sql`tenant_id = ${currentTenant}`,
  });

const ts = () => timestamp({ withTimezone: true });
const timestamps = {
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`),
};
// Inserts inside withTenant() get the tenant automatically and can't name another one.
const tenantId = () =>
  uuid()
    .notNull()
    .default(currentTenant)
    .references(() => tenants.id, { onDelete: 'cascade' });

export const tenants = pgTable(
  'tenants',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    status: text({ enum: ['active', 'paused'] })
      .notNull()
      .default('active'),
    /** Public id for the hosted lead form (/f/:formKey). Not a secret. */
    formKey: text()
      .notNull()
      .unique()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
    /** Webhook routing: Meta sends one webhook per app, we find the tenant by these ids. */
    waPhoneNumberId: text().unique(),
    /** The WhatsApp Business Account id: template status webhooks arrive under it, and templates are listed through it. */
    wabaId: text().unique(),
    /** Secret path segment of this tenant's inbound-email webhook (/webhooks/email-in/:key): portal lead emails are forwarded there. */
    emailInKey: text().unique(),
    metaPageId: text().unique(),
    /** Secret path segment of this tenant's phone-agent webhook (/webhooks/voice/:key). */
    voiceInKey: text().unique(),
    ...timestamps,
  },
  () => [pgPolicy('tenant_self', { for: 'select', to: appRole, using: sql`id = ${currentTenant}` })],
);

/** Append-only config revisions; the highest revision is active. */
export const tenantConfigs = pgTable(
  'tenant_configs',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    revision: integer().notNull(),
    config: jsonb().$type<TenantConfig>().notNull(),
    createdBy: uuid(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId, t.revision), tenantScoped()],
);

// ---- Better Auth tables (field keys must match Better Auth's names; columns are snake_case) ----

export const USER_ROLES = ['agency_admin', 'client_admin', 'client_staff'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    role: text().notNull().default('client_staff'),
    banned: boolean().default(false),
    banReason: text(),
    banExpires: ts(),
    // NULL only for agency admins, who act on tenants via the tenant switcher.
    tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  () => [tenantScoped()],
);

export const sessions = pgTable('sessions', {
  id: uuid().primaryKey().defaultRandom(),
  expiresAt: ts().notNull(),
  token: text().notNull().unique(),
  ipAddress: text(),
  userAgent: text(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  impersonatedBy: uuid(),
  ...timestamps,
});

export const accounts = pgTable('accounts', {
  id: uuid().primaryKey().defaultRandom(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: ts(),
  refreshTokenExpiresAt: ts(),
  scope: text(),
  password: text(),
  ...timestamps,
});

export const verifications = pgTable('verifications', {
  id: uuid().primaryKey().defaultRandom(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: ts().notNull(),
  ...timestamps,
});

// ---- Tenant credentials ----

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text().notNull(),
    prefix: text().notNull(),
    keyHash: text().notNull().unique(),
    lastUsedAt: ts(),
    revokedAt: ts(),
    createdBy: uuid(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

/** AES-256-GCM encrypted per-tenant secrets (see secrets.ts). */
export const tenantSecrets = pgTable(
  'tenant_secrets',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text().notNull(),
    valueEnc: text().notNull(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId, t.name), tenantScoped()],
);

/** Append-only (the app role has no UPDATE/DELETE). IDs only, never PII. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    actorType: text({ enum: ['user', 'api_key', 'system'] }).notNull(),
    actorId: uuid(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    details: jsonb().$type<Record<string, unknown>>(),
    occurredAt: ts().notNull(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

// ---- M2: leads, consent, messaging ----

export const LEAD_SOURCES = [
  'form',
  'meta_lead_ads',
  'click_to_whatsapp',
  'whatsapp',
  'api',
  'csv',
  'portal_email',
  /** Someone called the clinic and the phone agent picked up. */
  'phone_call',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const leads = pgTable(
  'leads',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    phoneE164: text().notNull(),
    name: text(),
    email: text(),
    language: text({ enum: LANGUAGES }),
    source: text({ enum: LEAD_SOURCES }).notNull(),
    sourceDetails: jsonb().$type<Record<string, unknown>>(),
    state: text({ enum: LEAD_STATES }).notNull().default('new'),
    tier: text({ enum: TIERS }),
    /** Deterministic score from answers (packages/core scoring), null until computed. */
    score: numeric({ precision: 6, scale: 2, mode: 'number' }),
    aiPaused: boolean().notNull().default(false),
    /** Set when the first messages show this isn't a real enquiry (spam, vendor, wrong number…). Excluded from reports. */
    notALead: text({ enum: ['wrong_number', 'vendor', 'job_seeker', 'spam', 'auto_reply'] }),
    /** WhatsApp told us this customer stopped marketing messages (error 131050 or the user_preferences webhook). Utility messages and chat replies are unaffected. */
    marketingOptOutAt: ts(),
    receivedAt: ts().notNull(),
    ...timestamps,
  },
  (t) => [
    unique().on(t.tenantId, t.phoneE164),
    index('leads_tenant_received').on(t.tenantId, t.receivedAt.desc()),
    tenantScoped(),
  ],
);

/** Evidence of consent: exact notice text shown, when, where. One row per grant. */
export const consents = pgTable(
  'consents',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    source: text().notNull(),
    channel: text().notNull().default('whatsapp'),
    noticeText: text().notNull(),
    evidence: jsonb().$type<Record<string, unknown>>(),
    grantedAt: ts().notNull(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

/**
 * Opt-outs keyed by an HMAC of the phone (not the phone itself) so they survive DPDP erasure
 * of the lead: a phone that opted out stays opted out.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    phoneHash: text().notNull(),
    reason: text({ enum: ['keyword', 'button', 'manual', 'provider'] }).notNull(),
    optedOutAt: ts().notNull(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId, t.phoneHash), tenantScoped()],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid()
      .notNull()
      .unique()
      .references(() => leads.id, { onDelete: 'cascade' }),
    channel: text().notNull().default('whatsapp'),
    lastInboundAt: ts(),
    /** 24 h after the last inbound message; free-form sends are allowed only before this. */
    windowExpiresAt: ts(),
    /** Rolling summary of the older part of a long conversation (memory_summarize task). */
    summary: text(),
    /** occurred_at of the last message the summary covers. */
    summaryUpTo: ts(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'received'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const messages = pgTable(
  'messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    direction: text({ enum: ['in', 'out'] }).notNull(),
    kind: text({ enum: ['text', 'buttons', 'template', 'button_reply', 'media', 'unsupported'] }).notNull(),
    body: text().notNull(),
    templateKey: text(),
    templateCategory: text({ enum: ['utility', 'marketing'] }),
    language: text(),
    payload: jsonb().$type<Record<string, unknown>>(),
    provider: text({ enum: ['fake', 'meta'] }),
    providerMessageId: text().unique(),
    /** Makes sends idempotent across job retries, e.g. `first_reply:<leadId>`. */
    idempotencyKey: text(),
    status: text({ enum: MESSAGE_STATUSES }).notNull(),
    error: jsonb().$type<{ code?: number; message: string }>(),
    estCostInr: numeric({ precision: 10, scale: 4, mode: 'number' }),
    /** Received (inbound) or sent (outbound) time, from the Clock. */
    occurredAt: ts().notNull(),
    ...timestamps,
  },
  (t) => [
    unique().on(t.tenantId, t.idempotencyKey),
    index('messages_lead_occurred').on(t.leadId, t.occurredAt),
    tenantScoped(),
  ],
);

/** Per-tenant approval status / provider names for the templates in packages/config. */
export const templates = pgTable(
  'templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    key: text().notNull(),
    language: text().notNull(),
    providerName: text().notNull(),
    category: text({ enum: ['utility', 'marketing'] }).notNull(),
    status: text({ enum: ['draft', 'submitted', 'approved', 'rejected'] })
      .notNull()
      .default('draft'),
    /** Meta's own status (APPROVED, PENDING, REJECTED, PAUSED, DISABLED, …) from the last sync or webhook. */
    providerStatus: text(),
    statusReason: text(),
    syncedAt: ts(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId, t.key, t.language), tenantScoped()],
);

/** Domain events (lead.created, lead.opted_out, …): history now, outbound webhooks later. */
export const events = pgTable(
  'events',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Copied from payload.leadId by emit(): the patient timeline reads events by it. No FK (ids only, pruned by retention). */
    leadId: uuid(),
    occurredAt: ts().notNull(),
    /** Outbound-webhook outbox: set once the event has been fanned out to the tenant's endpoints. */
    webhookDispatchedAt: ts(),
    ...timestamps,
  },
  (t) => [
    index('events_tenant_type_occurred').on(t.tenantId, t.type, t.occurredAt),
    index('events_lead_occurred').on(t.leadId, t.occurredAt),
    tenantScoped(),
  ],
);

// ---- M3: AI assistant ----

/** Qualification answers the assistant extracted (one current value per question). */
export const answers = pgTable(
  'answers',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: text().notNull(),
    answeredAt: ts().notNull(),
    ...timestamps,
  },
  (t) => [unique().on(t.leadId, t.key), tenantScoped()],
);

/** Every model call: tokens, cost, latency — for margin tracking and debugging. */
export const llmRuns = pgTable(
  'llm_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid().references(() => leads.id, { onDelete: 'set null' }),
    provider: text({ enum: ['anthropic', 'openai', 'gemini', 'xai', 'fake'] }).notNull(),
    model: text().notNull(),
    /** What the call was for (agent_reply, intent_classify, …); routing is per task. */
    task: text().notNull().default('agent_reply'),
    promptVersion: text(),
    /** True when an earlier model in the task's chain failed and this one stood in. */
    fallbackUsed: boolean().notNull().default(false),
    /** Output-guard problems found in this call's reply (it was repaired or replaced). */
    guardViolations: jsonb().$type<string[]>(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    latencyMs: integer().notNull(),
    stopReason: text(),
    error: text(),
    providerRequestId: text(),
    occurredAt: ts().notNull(),
    ...timestamps,
  },
  (t) => [
    index('llm_runs_tenant_occurred').on(t.tenantId, t.occurredAt),
    index('llm_runs_lead').on(t.leadId),
    tenantScoped(),
  ],
);

// ---- M4: booking ----

const WEEKDAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** When each resource (chair, doctor, site-visit agent) takes appointments, in tenant-local time. */
export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    weekday: text({ enum: WEEKDAY }).notNull(),
    startTime: text().notNull(), // HH:MM
    endTime: text().notNull(),
    resource: text().notNull().default('default'),
    ...timestamps,
  },
  () => [tenantScoped()],
);

/** One Google account per tenant (the refresh token lives in tenant_secrets). */
export const googleConnections = pgTable(
  'google_connections',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    /** `reauth_needed`: Google rejected the refresh token (revoked, expired); the clinic must reconnect. */
    status: text({ enum: ['ok', 'reauth_needed'] })
      .notNull()
      .default('ok'),
    lastError: text(),
    /** Space-separated scopes Google granted (tells us whether the calendar picker is allowed). */
    scopes: text(),
    connectedAt: ts().notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId), tenantScoped()],
);

/**
 * A Google calendar we sync. `resource` null = clinic-wide (its events block every doctor / agent);
 * otherwise it is that doctor's / agent's own calendar. Bookings for a resource are written to its
 * `writeBookings` link, else to the clinic-wide one, else to the account's primary calendar.
 */
export const calendarLinks = pgTable(
  'calendar_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    calendarId: text().notNull(),
    label: text(),
    resource: text(),
    /** Other people's events on this calendar block slots. */
    readBusy: boolean().notNull().default(true),
    /** Our bookings are written to this calendar. */
    writeBookings: boolean().notNull().default(true),
    syncToken: text(),
    channelId: text(),
    channelResourceId: text(),
    channelExpiresAt: ts(),
    lastSyncedAt: ts(),
    lastFullSyncAt: ts(),
    lastError: text(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId, t.calendarId), tenantScoped()],
);

/** OAuth `state` values already used (single-use: a replayed callback link does nothing). Pruned daily. */
export const oauthNonces = pgTable(
  'oauth_nonces',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    nonce: text().notNull(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId, t.nonce), tenantScoped()],
);

/** Holidays, leave, maintenance, and (source 'google') other people's events on a synced calendar. `resource` null blocks every resource. */
export const blockedTimes = pgTable(
  'blocked_times',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    startsAt: ts().notNull(),
    endsAt: ts().notNull(),
    resource: text(),
    reason: text(),
    source: text({ enum: ['manual', 'google'] })
      .notNull()
      .default('manual'),
    /** The Google event id (instance id for recurring events); idempotent upserts key on it. */
    externalId: text(),
    linkId: uuid().references(() => calendarLinks.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('blocked_times_link_external')
      .on(t.linkId, t.externalId)
      .where(sql`${t.source} = 'google'`),
    tenantScoped(),
  ],
);

export const APPOINTMENT_STATUSES = [
  'pending',
  'scheduled',
  'confirmed',
  'completed',
  'no_show',
  'cancelled',
  /** The visit time passed, nobody marked it, and the customer booked again: closed so it stops blocking them. Staff can still mark it. */
  'lapsed',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
/** Statuses that hold the resource (the no-double-booking constraint applies to these). */
export const ACTIVE_APPOINTMENT_STATUSES = ['pending', 'scheduled', 'confirmed'] as const;

/**
 * No double booking: an exclusion constraint (migration 0004) forbids two active appointments
 * on the same resource whose [starts_at, busy_until) ranges overlap.
 */
export const appointments = pgTable(
  'appointments',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    service: text().notNull(),
    resource: text().notNull(),
    startsAt: ts().notNull(),
    endsAt: ts().notNull(),
    /** endsAt + buffer: the resource is held until then. */
    busyUntil: ts().notNull(),
    status: text({ enum: APPOINTMENT_STATUSES }).notNull(),
    source: text({ enum: ['assistant', 'staff'] }).notNull(),
    /** Why it was cancelled when the business cancelled it (e.g. clinic_unavailable). */
    cancelReason: text(),
    /** Running-late notice already sent today (minutes). */
    lateNoticeMinutes: integer(),
    googleEventId: text(),
    /** The calendar `googleEventId` lives on (null = the account's primary). */
    googleCalendarId: text(),
    /** Who the visit is for when it is not the person messaging (a parent booking for a child). null = the lead themselves. */
    attendeeName: text(),
    notes: text(),
    /** The clinic's treatment plan this visit belongs to (completing it advances the plan). */
    treatmentPlanId: uuid().references((): AnyPgColumn => treatmentPlans.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    // One active booking per person: the lead (null) and each named family member separately.
    uniqueIndex('appointments_one_active_per_attendee')
      .on(t.tenantId, t.leadId, sql`lower(coalesce(${t.attendeeName}, ''))`)
      .where(sql`${t.status} in ('pending', 'scheduled', 'confirmed')`),
    tenantScoped(),
  ],
);

// ---- M5: sequences (definitions live in tenant config `sequences`) ----

export const SEQUENCE_KINDS = [
  'followup',
  'reminders',
  'no_show_recovery',
  'review_request',
  /** Staff-confirm bookings: nudge staff, then auto-confirm at the deadline. */
  'pending_watch',
  /** Reminder sent but not confirmed: tell staff before the visit. */
  'confirm_watch',
] as const;
export type SequenceKind = (typeof SEQUENCE_KINDS)[number];

/** A lead (optionally an appointment) going through one sequence. */
export const enrollments = pgTable(
  'enrollments',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    appointmentId: uuid().references(() => appointments.id, { onDelete: 'cascade' }),
    kind: text({ enum: SEQUENCE_KINDS }).notNull(),
    status: text({ enum: ['active', 'completed', 'stopped'] })
      .notNull()
      .default('active'),
    stopReason: text(),
    startedAt: ts().notNull(),
    ...timestamps,
  },
  (t) => [index('enrollments_lead').on(t.leadId), tenantScoped()],
);

/**
 * One scheduled action. A per-minute sweep claims due steps (business-clock `due_at`, so the
 * demo can fast-forward) and runs each as a pg-boss job keyed `enrollment:{id}:step:{n}`.
 */
export const enrollmentSteps = pgTable(
  'enrollment_steps',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    enrollmentId: uuid()
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    step: integer().notNull(),
    action: text({
      enum: ['message', 'mark_unresponsive', 'nudge_pending', 'auto_confirm', 'nudge_unconfirmed'],
    }).notNull(),
    templateKey: text(),
    channel: text({ enum: ['whatsapp', 'email', 'email_or_whatsapp'] }),
    dueAt: ts().notNull(),
    /** Don't send after this (e.g. a reminder after the appointment started). */
    deadlineAt: ts(),
    status: text({ enum: ['pending', 'queued', 'sent', 'skipped', 'failed', 'cancelled'] })
      .notNull()
      .default('pending'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    doneAt: ts(),
    ...timestamps,
  },
  (t) => [unique().on(t.enrollmentId, t.step), tenantScoped()],
);

// ---- M7: reports, alerts ----

export interface ReportData {
  period: { start: string; end: string; label: string };
  leads: number;
  medianFirstResponseSec: number | null;
  repliedLeads: number;
  replyRate: number | null;
  qualified: number;
  booked: number;
  shows: number;
  noShows: number;
  showRate: number | null;
  revenueRecoveredInr: number;
  upcomingBookings: number;
  /** Past appointments nobody marked Completed / No-show (optional: reports stored before it existed). */
  unmarkedVisits?: number;
  topTopics: { topic: string; count: number }[];
  costs: { monthStart: string; whatsappInr: number; llmUsd: number };
}

/** Weekly reports as sent (numbers computed from the database, never by the LLM). */
export const reports = pgTable(
  'reports',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    periodStart: ts().notNull(),
    periodEnd: ts().notNull(),
    data: jsonb().$type<ReportData>().notNull(),
    sentTo: jsonb().$type<string[]>(),
    sentAt: ts(),
    error: text(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId, t.periodStart), tenantScoped()],
);

/**
 * Operational alerts for the agency (deduped by key). tenant_id is null for system-wide ones
 * (queue backlog, dead letters); RLS still applies, so the app role never sees those.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
    key: text().notNull().unique(),
    kind: text().notNull(),
    message: text().notNull(),
    lastSeenAt: ts().notNull(),
    lastSentAt: ts(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

// ---- M8: integrations out, privacy ----

export const WEBHOOK_EVENTS = [
  'lead.created',
  'lead.qualified',
  'appointment.booked',
  'appointment.completed',
  'lead.opted_out',
] as const;

/** Client-owned endpoints that receive signed event POSTs (secret kept in tenant_secrets). */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    url: text().notNull(),
    events: jsonb().$type<string[]>().notNull(),
    active: boolean().notNull().default(true),
    lastStatus: integer(),
    lastError: text(),
    lastDeliveredAt: ts(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

/** DPDP: personal-data breaches the agency recorded (and when the Board / users were told). */
export const breachLog = pgTable(
  'breach_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().references(() => tenants.id, { onDelete: 'set null' }),
    detectedAt: ts().notNull(),
    description: text().notNull(),
    affectedCount: integer(),
    reportedToBoardAt: ts(),
    usersNotifiedAt: ts(),
    notes: text(),
    recordedBy: uuid(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

// ---- Operations employee: treatment journeys, calls, recovery opportunities, waitlist ----

export const TREATMENT_PLAN_STATUSES = ['proposed', 'accepted', 'in_progress', 'completed', 'declined'] as const;
export type TreatmentPlanStatus = (typeof TREATMENT_PLAN_STATUSES)[number];

/**
 * A treatment the clinic proposed (entered by staff, never by the AI): the administrative journey only, not a
 * clinical record. Money columns are what the clinic typed; null means "unknown", never estimated.
 */
export const treatmentPlans = pgTable(
  'treatment_plans',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    attendeeName: text(),
    /** Clinic wording, e.g. "Root canal, 3 visits". */
    title: text().notNull(),
    /** The service booked for the next visit (one of booking.services). */
    service: text(),
    status: text({ enum: TREATMENT_PLAN_STATUSES }).notNull().default('proposed'),
    visitsPlanned: integer(),
    visitsDone: integer().notNull().default(0),
    visitIntervalDays: integer(),
    nextVisitDueAt: ts(),
    recallDueAt: ts(),
    valueInr: numeric({ precision: 12, scale: 2, mode: 'number' }),
    paidInr: numeric({ precision: 12, scale: 2, mode: 'number' }),
    notes: text(),
    createdBy: uuid(),
    ...timestamps,
  },
  (t) => [
    index('treatment_plans_tenant_status_due').on(t.tenantId, t.status, t.nextVisitDueAt),
    index('treatment_plans_lead').on(t.leadId),
    tenantScoped(),
  ],
);

export const CALL_STATUSES = ['in_progress', 'completed', 'transferred', 'missed', 'failed'] as const;

/** Phone-agent calls (optional module). The summary is the vendor's; transcripts are not stored. */
export const calls = pgTable(
  'calls',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid().references(() => leads.id, { onDelete: 'cascade' }),
    provider: text({ enum: ['vapi'] }).notNull(),
    /** The vendor's call id: webhooks are retried, so every event upserts on it. */
    providerCallId: text().notNull(),
    direction: text({ enum: ['in', 'out'] })
      .notNull()
      .default('in'),
    status: text({ enum: CALL_STATUSES }).notNull().default('in_progress'),
    startedAt: ts().notNull(),
    endedAt: ts(),
    durationSec: integer(),
    afterHours: boolean().notNull().default(false),
    summary: text(),
    /** Why the call ended (the vendor's reason, e.g. customer-ended-call). */
    outcome: text(),
    transferred: boolean().notNull().default(false),
    escalated: boolean().notNull().default(false),
    /** Results of tool calls already run, by the vendor's tool-call id: a retried tool call gets the same answer. */
    toolResults: jsonb().$type<Record<string, string>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    unique().on(t.tenantId, t.providerCallId),
    index('calls_lead_started').on(t.leadId, t.startedAt),
    index('calls_tenant_started').on(t.tenantId, t.startedAt),
    tenantScoped(),
  ],
);

export const OPPORTUNITY_KINDS = [
  'LOST_LEAD',
  'EMPTY_SLOT',
  'NO_SHOW',
  'STALLED_TREATMENT',
  'RECALL_DUE',
  'PAYMENT_FOLLOWUP',
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];
export const OPPORTUNITY_STATUSES = ['open', 'needs_approval', 'actioned', 'won', 'lost', 'dismissed'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * Something worth recovering, found by deterministic rules (opportunities.ts). `subject_key` names what it is
 * about (an appointment, a plan, a slot, a recall cycle), so detecting it again is a no-op.
 */
export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    /** Null for an empty slot (it belongs to whoever takes it). */
    leadId: uuid().references(() => leads.id, { onDelete: 'cascade' }),
    kind: text({ enum: OPPORTUNITY_KINDS }).notNull(),
    subjectKey: text().notNull(),
    status: text({ enum: OPPORTUNITY_STATUSES }).notNull().default('open'),
    priority: integer().notNull(),
    reason: text().notNull(),
    recommendedAction: text().notNull(),
    detectedAt: ts().notNull(),
    aiActed: boolean().notNull().default(false),
    actedAt: ts(),
    outcome: text(),
    outcomeAt: ts(),
    /** Money only from the clinic's own data (a treatment plan); null = unavailable. */
    valueInr: numeric({ precision: 12, scale: 2, mode: 'number' }),
    valueSource: text({ enum: ['treatment_plan'] }),
    treatmentPlanId: uuid().references(() => treatmentPlans.id, { onDelete: 'cascade' }),
    appointmentId: uuid().references(() => appointments.id, { onDelete: 'set null' }),
    /** EMPTY_SLOT: the freed time. */
    slotStartsAt: ts(),
    slotResource: text(),
    slotService: text(),
    ...timestamps,
  },
  (t) => [
    unique().on(t.tenantId, t.kind, t.subjectKey),
    index('opportunities_tenant_status_priority').on(t.tenantId, t.status, t.priority.desc()),
    index('opportunities_lead').on(t.leadId),
    tenantScoped(),
  ],
);

/** People who want an (earlier) appointment if one frees up. */
export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    service: text().notNull(),
    resource: text(),
    attendeeName: text(),
    /** They already hold this booking and want an earlier time: accepting moves it. */
    appointmentId: uuid().references(() => appointments.id, { onDelete: 'set null' }),
    /** Tenant-local YYYY-MM-DD window (inclusive); null = any day. */
    fromDate: text(),
    toDate: text(),
    partOfDay: text({ enum: ['morning', 'afternoon', 'evening'] }),
    status: text({ enum: ['waiting', 'booked', 'removed', 'expired'] })
      .notNull()
      .default('waiting'),
    source: text({ enum: ['assistant', 'staff'] }).notNull(),
    joinedAt: ts().notNull(),
    ...timestamps,
  },
  (t) => [
    index('waitlist_tenant_status_service').on(t.tenantId, t.status, t.service, t.joinedAt),
    // One open entry per person and service.
    uniqueIndex('waitlist_one_open_per_person')
      .on(t.tenantId, t.leadId, t.service, sql`lower(coalesce(${t.attendeeName}, ''))`)
      .where(sql`${t.status} = 'waiting'`),
    tenantScoped(),
  ],
);

/** A freed slot offered to one waiting person. Unique per slot and person: nobody is offered the same slot twice. */
export const slotOffers = pgTable(
  'slot_offers',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    opportunityId: uuid()
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    waitlistEntryId: uuid()
      .notNull()
      .references(() => waitlistEntries.id, { onDelete: 'cascade' }),
    status: text({ enum: ['sent', 'accepted', 'declined', 'expired', 'superseded', 'failed'] })
      .notNull()
      .default('sent'),
    offeredAt: ts().notNull(),
    expiresAt: ts().notNull(),
    respondedAt: ts(),
    ...timestamps,
  },
  (t) => [
    unique().on(t.opportunityId, t.leadId),
    index('slot_offers_opportunity_status').on(t.opportunityId, t.status),
    tenantScoped(),
  ],
);
