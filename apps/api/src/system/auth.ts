import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins';
import { adminAc, userAc } from 'better-auth/plugins/admin/access';
import type { Db } from '../db/client.ts';
import { accounts, sessions, users, verifications } from '../db/schema.ts';
import type { Env } from '../env.ts';

export function createAuth(systemDb: Db, env: Pick<Env, 'APP_URL' | 'BETTER_AUTH_SECRET'>) {
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    // Sign-in happens before we know the tenant, so auth runs on the owner connection.
    database: drizzleAdapter(systemDb, {
      provider: 'pg',
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    // No public sign-up: the agency admin (or seed) creates users server-side.
    emailAndPassword: { enabled: true, disableSignUp: true },
    user: { additionalFields: { tenantId: { type: 'string', required: false, input: false } } },
    advanced: { database: { generateId: 'uuid' } },
    plugins: [
      admin({
        roles: { agency_admin: adminAc, client_admin: userAc, client_staff: userAc },
        adminRoles: ['agency_admin'],
        defaultRole: 'client_staff',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
