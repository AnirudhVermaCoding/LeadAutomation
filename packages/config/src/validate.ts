import { TenantConfigSchema, type TenantConfig } from './schema.ts';

type Path = readonly PropertyKey[];
interface Issue {
  path: Path;
  message: string;
}

/** Template variables usable anywhere in config text, besides `answers.<question key>`. */
export const TEMPLATE_VARIABLES = [
  'business_name',
  'assistant_name',
  'first_name',
  'appointment.time',
  'appointment.date',
  'appointment.service',
  'review_link',
  /** Staff messages: a short free-text note ("Priya hasn't confirmed…"). */
  'note',
  /** Running-late notices. */
  'delay_minutes',
] as const;

const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const formatPath = (path: Path): string =>
  path.reduce<string>(
    (out, p) => (typeof p === 'number' ? `${out}[${p}]` : out ? `${out}.${String(p)}` : String(p)),
    '',
  ) || '(root)';

function* strings(value: unknown, path: PropertyKey[] = []): Generator<[string, PropertyKey[]]> {
  if (typeof value === 'string') yield [value, path];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, [...path, i]);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) yield* strings(v, [...path, k]);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => (seen.has(v.toLowerCase()) ? true : (seen.add(v.toLowerCase()), false)));
}

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Rules zod can't express field-by-field. Messages are written for a clinic owner, not a developer. */
function crossFieldIssues(c: TenantConfig): Issue[] {
  const issues: Issue[] = [];
  const add = (path: Path, message: string) => issues.push({ path, message });
  const q = c.qualification;
  const questionKeys = new Set(q.questions.map((x) => x.key));

  // DPDP notice: every AI provider beyond the default must be disclosed to the people it processes.
  const PROVIDER_NAMES = { openai: 'OpenAI', gemini: 'Google', xai: 'xAI' } as const;
  for (const p of c.ai?.allowed_providers ?? [])
    if (
      p !== 'anthropic' &&
      !c.intake.consent_notice_text.toLowerCase().includes(PROVIDER_NAMES[p].toLowerCase())
    )
      add(
        ['intake', 'consent_notice_text'],
        `mention ${PROVIDER_NAMES[p]} in the consent notice before allowing it as an AI provider (customers must be told who processes their messages)`,
      );

  if (!c.brand.languages.includes(c.brand.default_language))
    add(
      ['brand', 'default_language'],
      `"${c.brand.default_language}" must also be listed in brand.languages`,
    );

  if (!isTimezone(c.locale.timezone))
    add(['locale', 'timezone'], `"${c.locale.timezone}" is not a known timezone (e.g. "Asia/Kolkata")`);

  c.locale.business_hours.forEach((h, i) => {
    if (h.open >= h.close)
      add(
        ['locale', 'business_hours', i],
        `opens at ${h.open} but closes at ${h.close}; closing must be later`,
      );
  });
  if (c.locale.quiet_hours.start === c.locale.quiet_hours.end)
    add(['locale', 'quiet_hours'], 'start and end are the same; quiet hours would be empty');

  for (const dup of duplicates(q.questions.map((x) => x.key)))
    add(['qualification', 'questions'], `question key "${dup}" is used more than once`);
  q.questions.forEach((x, i) => {
    for (const option of Object.keys(x.option_scores ?? {}))
      if (!x.options?.includes(option))
        add(
          ['qualification', 'questions', i, 'option_scores'],
          `"${option}" is not an option of question "${x.key}"`,
        );
    if (x.type === 'choice' && (x.options?.length ?? 0) < 2)
      add(
        ['qualification', 'questions', i, 'options'],
        `choice question "${x.key}" needs at least 2 options`,
      );
  });

  if (q.scoring.hot <= q.scoring.warm)
    add(
      ['qualification', 'scoring'],
      `hot threshold (${q.scoring.hot}) must be higher than warm (${q.scoring.warm})`,
    );
  q.scoring.disqualifiers.forEach((d, i) => {
    const question = q.questions.find((x) => x.key === d.question);
    if (!question) {
      add(
        ['qualification', 'scoring', 'disqualifiers', i, 'question'],
        `no question with key "${d.question}"`,
      );
    } else if (question.options) {
      const unknown = d.any_of.filter((v) => !question.options?.includes(v));
      if (unknown.length)
        add(
          ['qualification', 'scoring', 'disqualifiers', i, 'any_of'],
          `${unknown.map((v) => `"${v}"`).join(', ')} is not an option of question "${d.question}"`,
        );
    }
  });

  if (q.safety.emergency_keywords.length > 0 && !q.safety.emergency_response.trim())
    add(['qualification', 'safety', 'emergency_response'], 'required when emergency keywords are set');

  for (const dup of duplicates(c.booking.services.map((s) => s.name)))
    add(['booking', 'services'], `service "${dup}" is listed more than once`);

  const steps = c.sequences.followup.steps.map((s) => s.after_hours);
  if (steps.some((h, i) => i > 0 && h <= (steps[i - 1] ?? 0)))
    add(['sequences', 'followup', 'steps'], 'follow-up steps must be in increasing order of after_hours');
  if (c.sequences.review_request.enabled && !c.sequences.review_request.google_review_link)
    add(['sequences', 'review_request', 'google_review_link'], 'required when review requests are enabled');

  for (const [text, path] of strings(c)) {
    for (const [, name = ''] of text.matchAll(VARIABLE)) {
      const known =
        (TEMPLATE_VARIABLES as readonly string[]).includes(name) ||
        (name.startsWith('answers.') && questionKeys.has(name.slice('answers.'.length)));
      if (!known)
        add(
          path,
          `unknown variable {{${name}}}; use one of ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')} or {{answers.<question key>}}`,
        );
    }
  }

  return issues;
}

export type ConfigValidation = { ok: true; config: TenantConfig } | { ok: false; errors: string[] };

/** Validate untrusted config (dashboard form, JSON import). Errors are "path: message" strings. */
export function validateConfig(input: unknown): ConfigValidation {
  const parsed = TenantConfigSchema.safeParse(input);
  const issues: Issue[] = parsed.success ? crossFieldIssues(parsed.data) : parsed.error.issues;
  if (issues.length === 0 && parsed.success) return { ok: true, config: parsed.data };
  return { ok: false, errors: issues.map((i) => `${formatPath(i.path)}: ${i.message}`) };
}

/** Fill `{{name}}` variables in config text (consent notice, emergency reply). Unknown ones are left as-is. */
export const fillVariables = (text: string, values: Record<string, string>) =>
  text.replace(VARIABLE, (match, name: string) => values[name] ?? match);
