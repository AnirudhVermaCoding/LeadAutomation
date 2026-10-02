import { describe, expect, test } from 'vitest';
import {
  LEAD_EVENT_TYPES,
  LEAD_STATES,
  canTransition,
  displayStatus,
  initialLeadStatus,
  transition,
  type LeadEvent,
  type LeadEventType,
  type LeadStatus,
} from './lead-state.ts';

const ev = (type: LeadEventType): LeadEvent =>
  type === 'QUALIFIED' ? { type, tier: 'hot' } : ({ type } as LeadEvent);
const at = (state: LeadStatus['state']): LeadStatus => ({ state, tier: null, aiPaused: false });

describe('lead state machine', () => {
  test('full state x event matrix', () => {
    const matrix: Record<string, Record<string, string>> = {};
    for (const s of LEAD_STATES) {
      const row: Record<string, string> = {};
      for (const e of LEAD_EVENT_TYPES) {
        const lead = at(s);
        row[e] = canTransition(lead, ev(e)) ? transition(lead, ev(e)).state : 'x';
      }
      matrix[s] = row;
    }
    expect(matrix).toMatchSnapshot();
  });

  test('happy path new -> completed', () => {
    const path: LeadEvent[] = [
      { type: 'FIRST_CONTACT_SENT' },
      { type: 'LEAD_REPLIED' },
      { type: 'QUALIFIED', tier: 'warm' },
      { type: 'SLOTS_OFFERED' },
      { type: 'BOOKED' },
      { type: 'CONFIRMED' },
      { type: 'COMPLETED' },
    ];
    const end = path.reduce(transition, initialLeadStatus());
    expect(end).toEqual({ state: 'completed', tier: 'warm', aiPaused: false });
  });

  test('opt-out wins from every state and is left only by an explicit opt-in', () => {
    for (const s of LEAD_STATES) {
      const out = transition(at(s), { type: 'OPTED_OUT' });
      expect(out.state).toBe('opted_out');
      for (const e of LEAD_EVENT_TYPES) {
        if (e !== 'OPTED_IN' && canTransition(out, ev(e)))
          expect(transition(out, ev(e)).state).toBe('opted_out');
      }
    }
    expect(canTransition(at('opted_out'), { type: 'HUMAN_TAKEOVER' })).toBe(false);
  });

  test('opt-in works only from opted_out and starts a fresh conversation', () => {
    expect(transition(at('opted_out'), { type: 'OPTED_IN' })).toEqual({
      state: 'contacted',
      tier: null,
      aiPaused: false,
    });
    for (const s of LEAD_STATES.filter((x) => x !== 'opted_out'))
      expect(canTransition(at(s), { type: 'OPTED_IN' })).toBe(false);
  });

  test('human takeover pauses the AI without touching the funnel', () => {
    const paused = transition(at('qualifying'), { type: 'HUMAN_TAKEOVER' });
    expect(paused).toEqual({ state: 'qualifying', tier: null, aiPaused: true });
    expect(displayStatus(paused)).toBe('human_takeover');

    // Staff can still book during takeover, and the AI stays paused.
    const booked = transition(paused, { type: 'BOOKED' });
    expect(booked).toMatchObject({ state: 'booked', aiPaused: true });
    expect(transition(booked, { type: 'HUMAN_RESUME' })).toMatchObject({ state: 'booked', aiPaused: false });
  });

  test('replies are accepted in every state', () => {
    for (const s of LEAD_STATES) expect(canTransition(at(s), { type: 'LEAD_REPLIED' })).toBe(true);
  });
});
