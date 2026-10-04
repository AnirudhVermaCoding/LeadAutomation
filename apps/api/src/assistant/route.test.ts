import { describe, expect, test } from 'vitest';
import { classifyTurn, type TurnSignals } from './route.ts';

const base: TurnSignals = {
  text: '',
  upcomingAppointments: 0,
  buttonNote: false,
  staleReturning: false,
};
const of = (text: string, extra: Partial<TurnSignals> = {}) => classifyTurn({ ...base, text, ...extra });

describe('classifyTurn: rules decide the obvious cases, the judge only the rest', () => {
  test.each([
    ['hi', 'simple'],
    ['ok', 'simple'],
    ['2', 'simple'],
    ['yes 11am works', 'simple'],
    ['how much is cleaning?', 'simple'],
    ['kal shaam ko time hai kya', 'simple'],
    ['how much is cleaning? and do you open on sunday?', 'complex'],
    ['I want a refund for the whitening', 'complex'],
    ['can I get a discount if I bring my wife too', 'complex'],
    ['I was overcharged last time', 'complex'],
    ['mujhe paisa wapas chahiye', 'complex'],
    [
      'I saw your clinic on the way to work and was wondering what would suit my teeth best for a wedding next month',
      'ambiguous',
    ],
    [Array.from({ length: 61 }, () => 'word').join(' '), 'complex'],
  ])('%s -> %s', (text, expected) => expect(of(text)).toBe(expected));

  test('workflow state makes a turn complex whatever the text', () => {
    expect(of('ok', { upcomingAppointments: 2 })).toBe('complex');
    expect(of('ok', { buttonNote: true })).toBe('complex');
    expect(of('ok', { staleReturning: true })).toBe('complex');
    expect(of('ok', { upcomingAppointments: 1 })).toBe('simple');
  });
});
