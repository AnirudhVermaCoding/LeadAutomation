/** LLM providers a tenant may allow, and the tasks that call a model. */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'gemini', 'xai'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const LLM_TASKS = [
  'agent_reply',
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
 * registry (packages/integrations/src/llm/models.ts). Default tenants allow Anthropic only.
 */
export const DEFAULT_LLM_ROUTING: Record<LlmTaskName, string[]> = {
  agent_reply: [
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
    'gpt-6.1-sol',
    'gemini-3.8-flash',
    'grok-4.7',
  ],
  intent_classify: ['claude-haiku-4-5-20251001', 'gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-sonnet-5-5'],
  memory_summarize: ['claude-haiku-4-5-20251001', 'gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-sonnet-5-5'],
  language_detect: ['claude-haiku-4-5-20251001', 'gpt-6-luna', 'gemini-3.1-flash-lite'],
  // Reserved: weekly-report numbers are always SQL; no report task calls a model yet.
  report_text: ['claude-haiku-4-5-20251001', 'gpt-6-luna', 'gemini-3.1-flash-lite'],
};

export const DEFAULT_AI_SETTINGS: {
  allowed_providers: LlmProviderName[];
  monthly_cost_cap_usd: number;
  routing?: Partial<Record<LlmTaskName, string[]>>;
} = {
  allowed_providers: ['anthropic'],
  monthly_cost_cap_usd: 50,
};
