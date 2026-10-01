import { LANGUAGES, type TenantConfig } from '@instantlead/config';
import { LEAD_STATES, TIERS } from '@instantlead/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
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
    metaPageId: text().unique(),
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

export const LEAD_SOURCES = ['form', 'meta_lead_ads', 'click_to_whatsapp', 'whatsapp', 'api', 'csv'] as const;
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
    receivedAt: ts().notNull(),
    ...timestamps,
  },
  (t) => [unique().on(t.tenantId, t.phoneE164), tenantScoped()],
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
    kind: text({ enum: ['text', 'buttons', 'template', 'button_reply', 'unsupported'] }).notNull(),
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
  (t) => [unique().on(t.tenantId, t.idempotencyKey), tenantScoped()],
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
    occurredAt: ts().notNull(),
    ...timestamps,
  },
  () => [tenantScoped()],
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
    provider: text({ enum: ['anthropic', 'fake'] }).notNull(),
    model: text().notNull(),
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
  () => [tenantScoped()],
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

/** Holidays, leave, maintenance. `resource` null blocks every resource. */
export const blockedTimes = pgTable(
  'blocked_times',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    startsAt: ts().notNull(),
    endsAt: ts().notNull(),
    resource: text(),
    reason: text(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

export const APPOINTMENT_STATUSES = [
  'pending',
  'scheduled',
  'confirmed',
  'completed',
  'no_show',
  'cancelled',
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
    googleEventId: text(),
    notes: text(),
    ...timestamps,
  },
  () => [tenantScoped()],
);

// ---- M5: sequences (definitions live in tenant config `sequences`) ----

export const SEQUENCE_KINDS = ['followup', 'reminders', 'no_show_recovery', 'review_request'] as const;
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
  () => [tenantScoped()],
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
    action: text({ enum: ['message', 'mark_unresponsive'] }).notNull(),
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
