export * from './types.ts';
export * from './models.ts';
export {
  createOpenAICompatProvider,
  fromChatCompletion,
  OPENAI_COMPAT_BASE_URLS,
  toChatMessages,
} from './openai-compat.ts';

import { MODELS } from './models.ts';
import { createOpenAICompatProvider } from './openai-compat.ts';
import type { LlmProvider, ProviderName } from './types.ts';

export type ProviderKeys = Partial<Record<Exclude<ProviderName, 'fake'>, string | undefined>>;

/** A provider instance for a registered model, or null when its provider has no key (= disabled). */
export function providerForModel(model: string, keys: ProviderKeys): LlmProvider | null {
  const spec = MODELS[model];
  if (!spec || spec.provider === 'fake') return null;
  const apiKey = keys[spec.provider];
  if (!apiKey) return null;
  return createOpenAICompatProvider({ provider: spec.provider, apiKey, model });
}
