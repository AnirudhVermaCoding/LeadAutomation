import { loadEnv } from '../env.ts';
import { createAppContext } from './context.ts';

// Key rotation (docs/OPERATIONS.md): SECRETS_KEY=<new>, SECRETS_KEY_PREVIOUS=<old>, run this,
// then remove SECRETS_KEY_PREVIOUS.
if (import.meta.main) {
  const env = loadEnv();
  if (!env.SECRETS_KEY_PREVIOUS)
    console.warn('SECRETS_KEY_PREVIOUS is not set: re-encrypting with the same key');
  const ctx = createAppContext(env);
  try {
    console.log(`re-encrypted ${await ctx.system.rotateSecrets(ctx.secretsKey)} tenant secrets`);
  } finally {
    await ctx.close();
  }
}
