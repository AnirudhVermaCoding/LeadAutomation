import { createDb } from '../db/client.ts';

/**
 * Owner connection: bypasses RLS. Only for work that happens before a tenant is known
 * (API key lookup, auth, agency-admin tenant management). Lint keeps imports inside system/.
 */
export const createSystemDb = (url: string) => createDb(url, 4);
