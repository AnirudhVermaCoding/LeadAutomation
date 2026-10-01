import { systemClock, type Clock } from '@instantlead/core';
import { createDb } from '../db/client.ts';
import type { Env } from '../env.ts';
import { createAuth } from './auth.ts';
import { createSystemDb } from './db.ts';
import { createSystem } from './index.ts';

/** Composition root. `systemDb` stays in here; the rest of the app only sees `system` functions. */
export function createAppContext(env: Env, clock: Clock = systemClock) {
  const app = createDb(env.DATABASE_URL);
  const owner = createSystemDb(env.DATABASE_OWNER_URL);
  const auth = createAuth(owner.db, env);

  return {
    env,
    clock,
    db: app.db,
    auth,
    system: createSystem({ systemDb: owner.db, auth, clock }),
    secretsKey: Buffer.from(env.SECRETS_KEY, 'base64'),
    checkDb: async () => {
      await app.pool.query('select 1');
    },
    close: async () => {
      await Promise.all([app.pool.end(), owner.pool.end()]);
    },
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
