import { describe, expect, test } from 'vitest';
import { PRESETS, PRESET_KEYS, validateConfig, type TenantConfig } from './index.ts';

const clinic = (): TenantConfig => PRESETS.clinic_dental('Smile Dental');
const errorsFor = (mutate: (c: TenantConfig) => void): string[] => {
  const c = clinic();
  mutate(c);
  const r = validateConfig(c);
  return r.ok ? [] : r.errors;
};

describe('presets', () => {
  test.each(PRESET_KEYS)('%s is valid', (key) => {
    const r = validateConfig(PRESETS[key]());
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  test('JSON export -> import round-trips', () => {
    const r = validateConfig(JSON.parse(JSON.stringify(clinic())));
    expect(r.ok).toBe(true);
  });
});

describe('readable errors', () => {
  test('unknown template variable names the field and suggests valid ones', () => {
    expect(errorsFor((c) => (c.qualification.safety.emergency_response = 'Hi {{answers.budget}}'))).toEqual([
      expect.stringMatching(
        /^qualification\.safety\.emergency_response: unknown variable \{\{answers\.budget\}\}; use one of/,
      ),
    ]);
  });

  test('answers variables are allowed for configured question keys', () => {
    expect(errorsFor((c) => (c.intake.consent_notice_text += ' Re: {{answers.urgency}}'))).toEqual([]);
  });

  test('cross-field rules', () => {
    const errors = errorsFor((c) => {
      c.locale.timezone = 'India/Delhi';
      c.brand.default_language = 'hi';
      c.brand.languages = ['en'];
      c.booking.services.push({ name: 'consultation', duration_minutes: 10 });
      c.qualification.scoring.hot = 2;
      c.qualification.scoring.disqualifiers = [{ question: 'urgency', any_of: ['next_year'] }];
    });
    expect(errors).toEqual([
      'brand.default_language: "hi" must also be listed in brand.languages',
      'locale.timezone: "India/Delhi" is not a known timezone (e.g. "Asia/Kolkata")',
      'qualification.scoring: hot threshold (2) must be higher than warm (4)',
      'qualification.scoring.disqualifiers[0].any_of: "next_year" is not an option of question "urgency"',
      'booking.services: service "consultation" is listed more than once',
    ]);
  });

  test('field errors carry their path', () => {
    const c = clinic() as unknown as Record<string, unknown>;
    (c.booking as Record<string, unknown>).mode = 'manual';
    (c.locale as { quiet_hours: { start: string } }).quiet_hours.start = '9pm';
    c.extra = true;
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors;
    expect(errors).toContainEqual(expect.stringMatching(/^booking\.mode: /));
    expect(errors).toContainEqual('locale.quiet_hours.start: use 24-hour HH:MM, e.g. "09:30"');
    expect(errors).toContainEqual(expect.stringMatching(/^\(root\): Unrecognized key.*extra/));
  });

  test('review link required when review requests are on', () => {
    expect(errorsFor((c) => delete c.sequences.review_request.google_review_link)).toEqual([
      'sequences.review_request.google_review_link: required when review requests are enabled',
    ]);
  });
});

describe('AI providers', () => {
  test('Gemini is the only provider: Anthropic, OpenAI and xAI are refused on save', () => {
    for (const other of ['anthropic', 'openai', 'xai'])
      expect(
        errorsFor((c) => void (c.ai = { allowed_providers: [other as 'gemini'], monthly_cost_cap_usd: 50 })),
      ).toEqual([expect.stringMatching(/ai.allowed_providers.0/)]);
    expect(errorsFor((c) => void (c.ai = { allowed_providers: [], monthly_cost_cap_usd: 50 }))).toEqual([
      expect.stringMatching(/allow at least one AI provider/),
    ]);
  });

  test('the consent notice must name Google, with or without an ai section (no exemption for old notices)', () => {
    const oldNotice = (c: TenantConfig) => {
      delete c.ai;
      c.intake.consent_notice_text = 'Replies may be written by an AI assistant (processed by Anthropic).';
    };
    expect(errorsFor(oldNotice)).toEqual([expect.stringMatching(/consent_notice_text: mention Google/)]);
    expect(
      errorsFor((c) => {
        oldNotice(c);
        c.ai = { allowed_providers: ['gemini'], monthly_cost_cap_usd: 50 };
      }),
    ).toEqual([expect.stringMatching(/consent_notice_text: mention Google/)]);
  });

  test('the provider must be named as a word, not as part of another word', () => {
    const notice = (text: string) =>
      errorsFor((c) => {
        c.ai = { allowed_providers: ['gemini'], monthly_cost_cap_usd: 50 };
        c.intake.consent_notice_text = text;
      });
    expect(notice('Processed by Googleplex partners, among others.')).toHaveLength(1);
    expect(notice('Processed by Google (Gemini) on our behalf.')).toEqual([]);
  });
});

describe('treatment templates', () => {
  test('the dental preset ships templates without prices; a template must use a real booking service', () => {
    expect(clinic().treatment_templates?.map((t) => t.name)).toContain('Braces (metal)');
    expect(clinic().treatment_templates?.every((t) => t.value_inr === undefined)).toBe(true);
    expect(
      errorsFor((c) => c.treatment_templates!.push({ name: 'Veneers', service: 'Veneer fitting' })),
    ).toEqual(['treatment_templates[5].service: "Veneer fitting" is not one of your booking services']);
    expect(errorsFor((c) => c.treatment_templates!.push({ name: 'Braces (metal)' }))).toEqual([
      'treatment_templates: template "Braces (metal)" is listed more than once',
    ]);
  });
});
