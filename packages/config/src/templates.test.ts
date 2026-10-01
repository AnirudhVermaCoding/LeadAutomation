import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { renderTemplatesDoc, TEMPLATES_DOC_PATH } from './templates-doc.ts';
import {
  parseButtonPayload,
  renderTemplateBody,
  TEMPLATE_KEYS,
  TEMPLATE_LANGUAGES,
  TEMPLATES,
} from './templates.ts';
import { TEMPLATE_VARIABLES } from './validate.ts';

describe('template registry', () => {
  test.each(TEMPLATE_KEYS)('%s is well-formed for Meta', (key) => {
    const t = TEMPLATES[key];
    expect(t.providerName).toMatch(/^[a-z0-9_]{1,512}$/);
    expect(t.buttons.length).toBeLessThanOrEqual(3);
    for (const v of t.variables) expect(TEMPLATE_VARIABLES).toContain(v);
    for (const lang of TEMPLATE_LANGUAGES) {
      const placeholders = [...t.body[lang].matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      // Every variable is used, and nothing beyond the declared variables.
      expect(new Set(placeholders)).toEqual(new Set(t.variables.map((_, i) => i + 1)));
      expect(t.body[lang].length).toBeLessThanOrEqual(1024);
      for (const b of t.buttons as readonly { text: Record<string, string> }[])
        expect(b.text[lang]?.length).toBeLessThanOrEqual(25);
    }
  });

  test('renders positional values and round-trips button payloads', () => {
    expect(renderTemplateBody('followup_day2', 'en', ['Priya', 'Smile Dental'])).toBe(
      'Hi Priya, just checking in from Smile Dental. Would you still like help booking your visit?',
    );
    expect(parseButtonPayload('reminder_24h:confirm')).toEqual({ key: 'reminder_24h', buttonId: 'confirm' });
    expect(parseButtonPayload('nope:x')).toBeNull();
  });

  test('docs/TEMPLATES-TO-SUBMIT.md is up to date (run `pnpm templates:doc`)', () => {
    expect(readFileSync(TEMPLATES_DOC_PATH, 'utf8')).toBe(renderTemplatesDoc());
  });
});
