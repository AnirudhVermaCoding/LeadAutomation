import type { TenantConfig } from '@instantlead/config';
import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
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
