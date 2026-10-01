import type { PresetKey } from '@instantlead/config';
import { loadEnv } from '../env.ts';
import { createAppContext, type AppContext } from './context.ts';

const DEMO_TENANTS: { slug: string; name: string; preset: PresetKey }[] = [
  { slug: 'demo-clinic', name: 'Smile Dental (demo)', preset: 'clinic_dental' },
  { slug: 'demo-realestate', name: 'Skyline Realty (demo)', preset: 'real_estate' },
];

/** Idempotent: creates what's missing, leaves existing tenants and users alone. */
export async function seed(ctx: AppContext, log: (line: string) => void = console.log) {
  const { env, system } = ctx;
  const actor = { type: 'system' } as const;

  if (env.AGENCY_ADMIN_EMAIL && env.AGENCY_ADMIN_PASSWORD) {
    if (!(await system.findUserIdByEmail(env.AGENCY_ADMIN_EMAIL))) {
      await system.createUser({
        email: env.AGENCY_ADMIN_EMAIL,
        name: 'Agency Admin',
        password: env.AGENCY_ADMIN_PASSWORD,
        role: 'agency_admin',
        tenantId: null,
      });
      log(`agency admin created: ${env.AGENCY_ADMIN_EMAIL}`);
    }
  } else {
    log('AGENCY_ADMIN_EMAIL / AGENCY_ADMIN_PASSWORD not set: skipping agency admin');
  }

  if (!env.SEED_PASSWORD) return log('SEED_PASSWORD not set: skipping demo tenants');
  for (const t of DEMO_TENANTS) {
    if (await system.findTenantBySlug(t.slug)) continue;
    const { tenant } = await system.createTenant(
      { ...t, admin: { email: `admin@${t.slug}.test`, name: 'Demo Admin', password: env.SEED_PASSWORD } },
      actor,
    );
    await system.createUser({
      email: `staff@${t.slug}.test`,
      name: 'Demo Staff',
      password: env.SEED_PASSWORD,
      role: 'client_staff',
      tenantId: tenant.id,
    });
    const key = await system.createApiKey(tenant.id, 'demo key', actor);
    log(`${t.slug}: admin@${t.slug}.test / staff@${t.slug}.test (SEED_PASSWORD), API key ${key}`);
  }
}

if (import.meta.main) {
  const ctx = createAppContext(loadEnv());
  try {
    await seed(ctx);
  } finally {
    await ctx.close();
  }
}
