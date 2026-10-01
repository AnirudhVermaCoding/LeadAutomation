import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from '../test/context.ts';
import { withTenant } from './db/client.ts';
import { apiKeys, auditLog, sessions, tenantConfigs, tenants, tenantSecrets, users } from './db/schema.ts';
import { getTenantSecret, setTenantSecret } from './secrets.ts';

let t: TestContext;
let A: string;
let B: string;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  t = await createTestContext();
  const { system, db, secretsKey } = t.ctx;
  const actor = { type: 'system' } as const;
  A = (
    await system.createTenant(
      {
        slug: 'a',
        name: 'Clinic A',
        preset: 'clinic_dental',
        admin: { email: 'admin@a.test', name: 'A', password: PASSWORD },
      },
      actor,
    )
  ).tenant.id;
  B = (
    await system.createTenant(
      {
        slug: 'b',
        name: 'Clinic B',
        preset: 'clinic_skin',
        admin: { email: 'admin@b.test', name: 'B', password: PASSWORD },
      },
      actor,
    )
  ).tenant.id;
  keyA = await system.createApiKey(A, 'a key', actor);
  keyB = await system.createApiKey(B, 'b key', actor);
  await withTenant(db, A, (tx) => setTenantSecret(tx, secretsKey, A, 'whatsapp_token', 'secret-A'));
  await withTenant(db, B, (tx) => setTenantSecret(tx, secretsKey, B, 'whatsapp_token', 'secret-B'));
});
afterAll(() => t.close());

describe('tenant isolation (RLS)', () => {
  test('every table with a tenant_id column has row-level security enabled', async () => {
    const { rows } = await t.owner.query<{ table: string; rls: boolean }>(`
      select c.relname as table, c.relrowsecurity as rls
      from information_schema.columns col
      join pg_class c on c.relname = col.table_name
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = col.table_schema
      where col.table_schema = 'public' and col.column_name = 'tenant_id' and c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.filter((r) => !r.rls)).toEqual([]);
  });

  test('tenant A sees only its own rows in every table', async () => {
    await withTenant(t.ctx.db, A, async (tx) => {
      for (const table of [tenantConfigs, apiKeys, tenantSecrets, auditLog, users]) {
        const rows = await tx.select({ tenantId: table.tenantId }).from(table);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.tenantId === A)).toBe(true);
      }
      expect(await tx.select({ id: tenants.id }).from(tenants)).toEqual([{ id: A }]);
    });
  });

  test("tenant A cannot change or delete tenant B's rows", async () => {
    await withTenant(t.ctx.db, A, async (tx) => {
      const updated = await tx
        .update(tenantConfigs)
        .set({ revision: 99 })
        .where(eq(tenantConfigs.tenantId, B))
        .returning();
      expect(updated).toEqual([]);
      expect(await tx.delete(apiKeys).where(eq(apiKeys.tenantId, B)).returning()).toEqual([]);
    });
    const stillThere = await t.owner.query('select 1 from api_keys where tenant_id = $1', [B]);
    expect(stillThere.rowCount).toBe(1);
  });

  test('tenant A cannot insert rows for tenant B', async () => {
    await expect(
      withTenant(t.ctx.db, A, (tx) =>
        tx.insert(tenantSecrets).values({ tenantId: B, name: 'x', valueEnc: 'v1.x.y.z' }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test('without a tenant context nothing is visible and nothing can be written', async () => {
    expect(await t.ctx.db.select().from(tenantConfigs)).toEqual([]);
    expect(await t.ctx.db.select().from(tenants)).toEqual([]);
    await expect(
      t.ctx.db.insert(tenantSecrets).values({ name: 'x', valueEnc: 'v1.x.y.z' }),
    ).rejects.toThrow();
  });

  test('audit log is append-only and auth tables are off-limits to the app role', async () => {
    await expect(
      withTenant(t.ctx.db, A, (tx) => tx.update(auditLog).set({ action: 'tampered' })),
    ).rejects.toThrow(/permission denied/);
    await expect(withTenant(t.ctx.db, A, (tx) => tx.delete(auditLog))).rejects.toThrow(/permission denied/);
    await expect(t.ctx.db.select().from(sessions)).rejects.toThrow(/permission denied/);
  });

  test('withTenant rejects non-uuid tenant ids', async () => {
    await expect(withTenant(t.ctx.db, "x' or '1'='1", async () => 0)).rejects.toThrow(/uuid/);
  });
});

describe('tenant secrets', () => {
  test('decrypt only for the owning tenant', async () => {
    const { db, secretsKey } = t.ctx;
    expect(await withTenant(db, A, (tx) => getTenantSecret(tx, secretsKey, A, 'whatsapp_token'))).toBe(
      'secret-A',
    );
    expect(await withTenant(db, A, (tx) => getTenantSecret(tx, secretsKey, A, 'missing'))).toBeNull();

    // Copy B's ciphertext into A's row: the AAD binding makes it undecryptable there.
    await t.owner.query(
      `update tenant_secrets set value_enc = (select value_enc from tenant_secrets where tenant_id = $2)
       where tenant_id = $1`,
      [A, B],
    );
    await expect(
      withTenant(db, A, (tx) => getTenantSecret(tx, secretsKey, A, 'whatsapp_token')),
    ).rejects.toThrow();
  });

  test('stored value is not plaintext', async () => {
    const { rows } = await t.owner.query<{ value_enc: string }>('select value_enc from tenant_secrets');
    expect(rows.every((r) => r.value_enc.startsWith('v1.') && !r.value_enc.includes('secret-'))).toBe(true);
  });
});

describe('api keys', () => {
  test('a key resolves to its own tenant, and stops working once revoked', async () => {
    const { system, db, clock } = t.ctx;
    expect(await system.resolveApiKey(keyA)).toMatchObject({ tenantId: A });
    expect(await system.resolveApiKey(keyB)).toMatchObject({ tenantId: B });
    expect(await system.resolveApiKey('il_not-a-real-key')).toBeNull();

    await withTenant(db, B, (tx) => tx.update(apiKeys).set({ revokedAt: clock.now() }));
    expect(await system.resolveApiKey(keyB)).toBeNull();
  });

  test('only the hash is stored', async () => {
    const { rows } = await t.owner.query<{ key_hash: string }>('select key_hash from api_keys');
    expect(rows.map((r) => r.key_hash)).not.toContain(keyA);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.key_hash))).toBe(true);
  });
});
