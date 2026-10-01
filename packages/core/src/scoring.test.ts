import { describe, expect, test } from 'vitest';
import { detectLanguage } from './language.ts';
import { matchesEmergency } from './messaging.ts';
import { scoreLead, type ScoringConfig } from './scoring.ts';

const config: ScoringConfig = {
  questions: [
    { key: 'treatment', required: true, weight: 3 },
    {
      key: 'urgency',
      required: true,
      weight: 4,
      option_scores: { today: 1, this_week: 0.75, just_exploring: 0 },
    },
    { key: 'location', required: false, weight: 1 },
  ],
  scoring: { hot: 7, warm: 4, disqualifiers: [{ question: 'location', any_of: ['outside_city'] }] },
};

describe('scoring', () => {
  test('incomplete until required questions are answered', () => {
    expect(scoreLead(config, { treatment: 'whitening' })).toEqual({
      status: 'incomplete',
      missing: ['urgency'],
      score: 3,
    });
  });

  test('tiers follow the thresholds and option scores', () => {
    expect(scoreLead(config, { treatment: 'x', urgency: 'today', location: 'Andheri' })).toEqual({
      status: 'qualified',
      score: 8,
      tier: 'hot',
    });
    expect(scoreLead(config, { treatment: 'x', urgency: 'this_week' })).toEqual({
      status: 'qualified',
      score: 6,
      tier: 'warm',
    });
    expect(scoreLead(config, { treatment: 'x', urgency: 'just_exploring' })).toEqual({
      status: 'qualified',
      score: 3,
      tier: 'cold',
    });
  });

  test('disqualifiers win regardless of score', () => {
    expect(scoreLead(config, { treatment: 'x', urgency: 'today', location: 'outside_city' })).toEqual({
      status: 'disqualified',
      question: 'location',
      answer: 'outside_city',
    });
  });

  test('is deterministic', () => {
    const answers = { urgency: 'this_week', treatment: 'braces' };
    expect(scoreLead(config, answers)).toEqual(scoreLead(config, { ...answers }));
  });
});

describe('language detection', () => {
  test.each([
    ['Hello, how much is teeth whitening?', 'en'],
    ['मुझे कल दांत दिखाना है', 'hi'],
    ['mujhe kal appointment chahiye', 'hinglish'],
    ['kitna lagega?', 'hinglish'],
    ['Can I come tomorrow at 5?', 'en'],
    ['👍', null],
    ['ok', null],
  ] as const)('%s -> %s', (text, lang) => expect(detectLanguage(text)).toBe(lang));
});

describe('emergency pre-check', () => {
  const keywords = ['severe pain', 'bleeding', 'bahut dard', 'खून'];
  test.each([
    'My gum is BLEEDING a lot',
    'bahut dard ho raha hai',
    'मुँह से खून आ रहा है',
    'severe pain since morning!',
  ])('escalates: %s', (text) => expect(matchesEmergency(text, keywords)).toBe(true));
  test.each(['Is cleaning painful?', 'I want whitening'])('does not escalate: %s', (text) =>
    expect(matchesEmergency(text, keywords)).toBe(false),
  );
});
