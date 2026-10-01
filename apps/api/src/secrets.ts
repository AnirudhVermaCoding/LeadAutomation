import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Tx } from './db/client.ts';
import { tenantSecrets } from './db/schema.ts';

// Format: v1.<iv>.<tag>.<ciphertext> (base64url). The version lets us rotate keys later
// without a schema change. AAD binds a ciphertext to its tenant and name, so it can't be
// copied to another tenant's row and decrypted there.

/** The current key, or [current, ...previous] during a key rotation (see docs/OPERATIONS.md). */
export type SecretsKey = Buffer | readonly Buffer[];
const ring = (key: SecretsKey): readonly Buffer[] => (Buffer.isBuffer(key) ? [key] : key);

const aad = (tenantId: string, name: string) => Buffer.from(`${tenantId}:${name}`);

export function encryptSecret(keys: SecretsKey, tenantId: string, name: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring(keys)[0]!, iv).setAAD(aad(tenantId, name));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(keys: SecretsKey, tenantId: string, name: string, blob: string): string {
  const [version, iv, tag, ct] = blob.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported secret format');
  let lastError: unknown;
  for (const key of ring(keys)) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
        .setAAD(aad(tenantId, name))
        .setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
        'utf8',
      );
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export async function setTenantSecret(
  tx: Tx,
  key: SecretsKey,
  tenantId: string,
  name: string,
  value: string,
) {
  const valueEnc = encryptSecret(key, tenantId, name, value);
  await tx
    .insert(tenantSecrets)
    .values({ tenantId, name, valueEnc })
    .onConflictDoUpdate({ target: [tenantSecrets.tenantId, tenantSecrets.name], set: { valueEnc } });
}

export async function getTenantSecret(tx: Tx, key: SecretsKey, tenantId: string, name: string) {
  const [row] = await tx
    .select({ valueEnc: tenantSecrets.valueEnc })
    .from(tenantSecrets)
    .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.name, name)));
  return row ? decryptSecret(key, tenantId, name, row.valueEnc) : null;
}
