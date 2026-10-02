export const LEAD_STATES = [
  'new',
  'contacted',
  'qualifying',
  'qualified',
  'disqualified',
  'booking_offered',
  'booked',
  'confirmed',
  'completed',
  'no_show',
  'nurturing',
  'unresponsive',
  'opted_out',
] as const;
export type LeadState = (typeof LEAD_STATES)[number];

export const TIERS = ['hot', 'warm', 'cold'] as const;
export type Tier = (typeof TIERS)[number];

/** Funnel position plus the orthogonal "AI paused / human takeover" flag. */
export interface LeadStatus {
  state: LeadState;
  tier: Tier | null;
  aiPaused: boolean;
}

// Funnel events: allowed source states -> target state.
const FUNNEL = {
  FIRST_CONTACT_SENT: { from: ['new'], to: 'contacted' },
  LEAD_REPLIED: { from: ['new', 'contacted', 'nurturing', 'unresponsive'], to: 'qualifying' },
  QUALIFIED: { from: ['qualifying', 'qualified'], to: 'qualified' },
  DISQUALIFIED: {
    from: ['new', 'contacted', 'qualifying', 'qualified', 'booking_offered', 'nurturing'],
    to: 'disqualified',
  },
  SLOTS_OFFERED: {
    from: ['qualifying', 'qualified', 'booking_offered', 'nurturing', 'no_show', 'completed'],
    to: 'booking_offered',
  },
  // Staff can book anyone who calls in, so every non-terminal state may book.
  BOOKED: {
    from: [
      'new',
      'contacted',
      'qualifying',
      'qualified',
      'booking_offered',
      'nurturing',
      'unresponsive',
      'no_show',
      'completed',
    ],
    to: 'booked',
  },
  CONFIRMED: { from: ['booked'], to: 'confirmed' },
  RESCHEDULED: { from: ['booked', 'confirmed'], to: 'booked' },
  CANCELLED: { from: ['booked', 'confirmed'], to: 'qualified' },
  COMPLETED: { from: ['booked', 'confirmed'], to: 'completed' },
  NO_SHOW: { from: ['booked', 'confirmed'], to: 'no_show' },
  NURTURE: { from: ['qualifying', 'qualified', 'booking_offered'], to: 'nurturing' },
  // Staff: a lead tagged as junk (or disqualified) was a real enquiry after all.
  REQUALIFY: { from: ['disqualified'], to: 'qualifying' },
  MARK_UNRESPONSIVE: {
    from: ['contacted', 'qualifying', 'qualified', 'booking_offered', 'nurturing'],
    to: 'unresponsive',
  },
} as const satisfies Record<string, { from: readonly LeadState[]; to: LeadState }>;

type FunnelEventType = keyof typeof FUNNEL;
export type LeadEventType = FunnelEventType | 'OPTED_OUT' | 'HUMAN_TAKEOVER' | 'HUMAN_RESUME';
export const LEAD_EVENT_TYPES: readonly LeadEventType[] = [
  ...(Object.keys(FUNNEL) as FunnelEventType[]),
  'OPTED_OUT',
  'HUMAN_TAKEOVER',
  'HUMAN_RESUME',
];

export type LeadEvent = { type: 'QUALIFIED'; tier: Tier } | { type: Exclude<LeadEventType, 'QUALIFIED'> };

export class InvalidTransitionError extends Error {
  readonly from: LeadState;
  readonly event: LeadEventType;

  constructor(from: LeadState, event: LeadEventType) {
    super(`Lead in state "${from}" cannot handle ${event}`);
    this.from = from;
    this.event = event;
  }
}

export const initialLeadStatus = (): LeadStatus => ({ state: 'new', tier: null, aiPaused: false });

/** Pure transition. Throws InvalidTransitionError when the event is not allowed. */
export function transition(lead: LeadStatus, event: LeadEvent): LeadStatus {
  // Opt-out always wins and is permanent; replies after opting out change nothing.
  if (event.type === 'OPTED_OUT') return { ...lead, state: 'opted_out' };
  if (lead.state === 'opted_out') {
    if (event.type === 'LEAD_REPLIED') return lead;
    throw new InvalidTransitionError(lead.state, event.type);
  }

  if (event.type === 'HUMAN_TAKEOVER') return { ...lead, aiPaused: true };
  if (event.type === 'HUMAN_RESUME') return { ...lead, aiPaused: false };

  const rule = FUNNEL[event.type];
  if (!(rule.from as readonly LeadState[]).includes(lead.state)) {
    // An inbound reply is normal in any state (e.g. a booked patient asking about parking).
    if (event.type === 'LEAD_REPLIED') return lead;
    throw new InvalidTransitionError(lead.state, event.type);
  }

  return {
    ...lead,
    state: rule.to,
    tier: event.type === 'QUALIFIED' ? event.tier : lead.tier,
  };
}

export function canTransition(lead: LeadStatus, event: LeadEvent): boolean {
  try {
    transition(lead, event);
    return true;
  } catch (err) {
    if (err instanceof InvalidTransitionError) return false;
    throw err;
  }
}

/** What the inbox shows: human takeover overrides the funnel label. */
export const displayStatus = (lead: LeadStatus): LeadState | 'human_takeover' =>
  lead.aiPaused && lead.state !== 'opted_out' ? 'human_takeover' : lead.state;
