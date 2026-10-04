/** LLM providers a tenant may allow, and the tasks that call a model. */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'gemini', 'xai'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const LLM_TASKS = [
  'agent_reply',
  'agent_reply_complex',
  'message_route',
  'intent_classify',
  'memory_summarize',
  'language_detect',
  'report_text',
] as const;
export type LlmTaskName = (typeof LLM_TASKS)[number];

/**
 * Global routing: primary model first, then fallbacks in order. Each tenant can override a task
 * (`ai.routing`); the router then drops models whose provider has no key, isn't in the tenant's
 * `allowed_providers`, or lacks a capability the task needs. Model ids must exist in the
 * registry (packages/integrations/src/llm/models.ts). Default tenants allow Google (Gemini) only;
 * Claude is not in any default chain (a tenant can still add one through `ai.routing`).
 */
const SMALL = ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'];
export const DEFAULT_LLM_ROUTING: Record<LlmTaskName, string[]> = {
  agent_reply: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
  // Turns the router judged complex (assistant/route.ts).
  agent_reply_complex: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  // The judge, only for turns the deterministic rules can't classify.
  message_route: SMALL,
  intent_classify: SMALL,
  memory_summarize: SMALL,
  language_detect: SMALL,
  // Reserved: weekly-report numbers are always SQL; no report task calls a model yet.
  report_text: SMALL,
};

export const DEFAULT_AI_SETTINGS: {
  allowed_providers: LlmProviderName[];
  monthly_cost_cap_usd: number;
  routing?: Partial<Record<LlmTaskName, string[]>>;
} = {
  allowed_providers: ['gemini'],
  monthly_cost_cap_usd: 50,
};

/** How each provider must be named in the consent notice (DPDP: customers are told who processes their messages). */
export const PROVIDER_NAMES: Record<LlmProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google',
  xai: 'xAI',
};

/**
 * Whether the consent notice discloses this provider. Anthropic is exempt: notices saved before this
 * rule named it as the only processor. Checked on save (validate.ts) and again by the router before
 * any customer text is sent, so an old notice never silently covers a new default provider.
 */
export const providerDisclosed = (consentNotice: string, provider: LlmProviderName) =>
  provider === 'anthropic' || new RegExp(`\\b${PROVIDER_NAMES[provider]}\\b`, 'i').test(consentNotice);
