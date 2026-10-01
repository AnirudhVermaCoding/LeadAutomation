import { PRESETS, type PresetKey } from '@instantlead/config';
import type { Clock } from '@instantlead/core';
import { and, eq, isNull } from 'drizzle-orm';
import { generateApiKey, hashApiKey } from '../api-keys.ts';
import { audit, type Actor } from '../audit.ts';
import type { Db } from '../db/client.ts';
import { apiKeys, tenantConfigs, tenants, users, type UserRole } from '../db/schema.ts';
import type { Auth } from './auth.ts';

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
        await tx.insert(tenantConfigs).values({
          tenantId: t.id,
          revision: 1,
          config: PRESETS[input.preset](input.name),
          createdBy: actor.type === 'user' ? actor.id : null,
        });
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
