import { LLM_PROVIDERS, LLM_TASKS } from './llm.ts';
import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:MM, e.g. "09:30"');
const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'use lowercase letters, digits and underscores, e.g. "treatment_interest"');
const nonEmpty = z.string().trim().min(1, 'cannot be empty');

export const LANGUAGES = ['en', 'hi', 'hinglish'] as const;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const INTAKE_SOURCES = ['form', 'meta_lead_ads', 'click_to_whatsapp', 'api', 'csv'] as const;

/** Actions the AI can be allowed to take (Settings → AI autonomy). The never-list is not configurable: see NEVER_ACTIONS. */
export const AUTONOMY_ACTIONS = [
  'faq',
  'book',
  'reschedule',
  'cancel',
  'remind',
  'follow_up',
  'waitlist_offer',
  'reactivate',
  'payment_reminder',
] as const;
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number];
export type AutonomyMode = 'auto' | 'approval' | 'off';

/** Hard-coded in the prompt and the output guard; no setting can turn these on. */
export const NEVER_ACTIONS = [
  'diagnose a condition',
  'prescribe or name medicines or doses',
  'change or recommend clinical treatment',
  'interpret symptoms, reports or photos',
  'state medical facts or prices that are not in the clinic information',
  'override clinic policy',
  'make emergency decisions (emergencies go to the clinic immediately)',
] as const;

const Language = z.enum(LANGUAGES);
const Weekday = z.enum(WEEKDAYS);

const Question = z.object({
  key,
  hint: nonEmpty,
  type: z.enum(['text', 'choice', 'number', 'yes_no', 'date']),
  options: z.array(nonEmpty).optional(),
  /** 0..1 per option: how strongly each answer signals a ready-to-book lead (unlisted options count as 1). */
  option_scores: z.record(z.string(), z.number().min(0).max(1)).optional(),
  required: z.boolean(),
  weight: z.number().min(0).max(10),
});

export const TenantConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  brand: z.strictObject({
    business_name: nonEmpty,
    assistant_name: nonEmpty,
    tone: nonEmpty,
    languages: z.array(Language).min(1, 'pick at least one language'),
    default_language: Language,
  }),
  locale: z.strictObject({
    timezone: nonEmpty,
    business_hours: z
      .array(z.strictObject({ days: z.array(Weekday).min(1), open: hhmm, close: hhmm }))
      .min(1, 'add at least one opening-hours row'),
    quiet_hours: z.strictObject({ start: hhmm, end: hhmm }),
  }),
  intake: z.strictObject({
    sources: z.array(z.enum(INTAKE_SOURCES)).min(1),
    consent_notice_text: z.string().trim().min(20, 'write the full consent notice shown to the lead'),
    opt_out_keywords: z.array(nonEmpty).min(1, 'add at least one opt-out keyword, e.g. "stop"'),
    /** Words that bring an opted-out customer back (default: DEFAULT_OPT_IN_KEYWORDS). */
    opt_in_keywords: z.array(nonEmpty).optional(),
    /** Sent right after someone opts out ({{business_name}} allowed). Default text in English / Hindi / Hinglish. */
    opt_out_confirmation: z.string().trim().min(10).max(500).optional(),
  }),
  qualification: z.strictObject({
    max_turns: z.int().min(1).max(20),
    questions: z.array(Question).min(1, 'add at least one qualification question'),
    scoring: z.strictObject({
      hot: z.number().min(0),
      warm: z.number().min(0),
      disqualifiers: z.array(z.strictObject({ question: key, any_of: z.array(nonEmpty).min(1) })),
    }),
    knowledge: z.array(z.strictObject({ title: nonEmpty, content: nonEmpty })),
    safety: z.strictObject({
      emergency_keywords: z.array(nonEmpty),
      emergency_response: z.string(),
      /** The same reply in Hindi / Hinglish, sent when the customer writes in that language. Falls back to `emergency_response`. */
      emergency_response_i18n: z
        .strictObject({ hi: z.string().optional(), hinglish: z.string().optional() })
        .optional(),
      no_medical_advice: z.boolean(),
    }),
  }),
  booking: z.strictObject({
    slot_minutes: z.int().min(5).max(240),
    buffer_minutes: z.int().min(0).max(120),
    services: z
      .array(
        z.strictObject({
          name: nonEmpty,
          duration_minutes: z.int().min(5).max(480),
          /** Concerns this service is the right first step for, in customers' words (symptom -> booking). */
          suitable_for: z.array(nonEmpty).max(40).optional(),
        }),
      )
      .min(1),
    mode: z.enum(['auto_confirm', 'staff_confirm']),
    offer_slots: z.int().min(1).max(5),
    /** staff_confirm only: if staff haven't confirmed by the deadline (4 h before, or the evening before), confirm automatically. Default true. */
    auto_confirm_pending: z.boolean().optional(),
    /** Customers can change or cancel by chat / buttons only up to this many hours before the visit (staff can always). Default 2. */
    change_notice_hours: z.int().min(0).max(168).optional(),
    /** Shown to the customer when a change is too late, and available to the assistant as the clinic's policy. */
    cancellation_policy: z.string().trim().max(500).optional(),
    staff_notify: z.strictObject({ channel: z.enum(['whatsapp', 'email']), to: nonEmpty }),
  }),
  sequences: z.strictObject({
    followup: z.strictObject({
      steps: z.array(
        z.strictObject({
          after_hours: z.number().positive(),
          channel: z.enum(['whatsapp', 'email', 'email_or_whatsapp']),
        }),
      ),
      stop_on: z.array(z.enum(['replied', 'booked', 'opted_out', 'disqualified'])),
    }),
    reminders: z.strictObject({ before_hours: z.array(z.number().positive()) }),
    no_show_recovery: z.strictObject({ enabled: z.boolean(), after_hours: z.number().min(0) }),
    review_request: z.strictObject({
      enabled: z.boolean(),
      after_hours: z.number().min(0),
      google_review_link: z.url().optional(),
    }),
  }),
  /** DPDP: how long to keep lead data after the last activity. 0 = keep. Optional for configs saved before it existed. */
  privacy: z
    .strictObject({
      retention_days: z.int().min(0).max(3650),
      mode: z.enum(['anonymize', 'delete']),
    })
    .optional(),
  /** Which AI providers may process this tenant's conversations, spend cap, optional per-task routing. Optional for older configs (defaults: Anthropic only, $50/month). */
  ai: z
    .strictObject({
      allowed_providers: z.array(z.enum(LLM_PROVIDERS)).min(1, 'allow at least one AI provider'),
      monthly_cost_cap_usd: z.number().min(0).max(100_000),
      routing: z.partialRecord(z.enum(LLM_TASKS), z.array(nonEmpty).min(1)).optional(),
    })
    .optional(),
  /** What the AI may do by itself, what needs staff approval, what it never does here. Optional (defaults: AUTONOMY_DEFAULTS). */
  autonomy: z.partialRecord(z.enum(AUTONOMY_ACTIONS), z.enum(['auto', 'approval', 'off'])).optional(),
  /** Treatment follow-up, recall, recovery and waitlist rules. Optional (defaults: JOURNEY_DEFAULTS). */
  journeys: z
    .strictObject({
      stall_grace_days: z.int().min(1).max(90),
      recall_months: z.int().min(1).max(36),
      lost_lead_after_hours: z.int().min(12).max(720),
      max_outreach_per_day: z.int().min(0).max(500),
      /** The clinic's own payment page (UPI / gateway link) sent in payment reminders. https only. */
      payment_url: z
        .url()
        .refine((u) => u.startsWith('https://'), 'must start with https://')
        .optional(),
      waitlist_offer_minutes: z
        .int()
        .min(5)
        .max(24 * 60),
      waitlist_batch: z.int().min(1).max(10),
    })
    .optional(),
  /** Optional AI phone receptionist. Off unless enabled; outbound calling is not supported. */
  voice: z
    .strictObject({
      enabled: z.boolean(),
      provider: z.enum(['vapi']),
      /** Where a caller is transferred to reach a person (E.164). Without it the agent takes a message. */
      transfer_number: z
        .string()
        .regex(/^\+[1-9]\d{9,14}$/, 'use the international format, e.g. +919876543210')
        .optional(),
      /** Said at the start of each call ({{business_name}} allowed). */
      call_disclosure: z.string().trim().min(20).max(400),
      /** Phone-agent minutes per calendar month; above it calls go straight to the clinic. 0 = no limit. */
      monthly_minutes_cap: z.int().min(0).max(100_000),
    })
    .optional(),
  /** One-click starting points for treatment plans (staff can change every field). Optional. */
  treatment_templates: z
    .array(
      z.strictObject({
        name: nonEmpty.max(80),
        service: nonEmpty.optional(),
        visits_planned: z.int().min(1).max(50).optional(),
        visit_interval_days: z.int().min(1).max(365).optional(),
        /** The clinic's usual price; optional, never guessed. */
        value_inr: z.number().min(0).max(100_000_000).optional(),
        installments: z
          .strictObject({ count: z.int().min(2).max(60), interval_days: z.int().min(7).max(365) })
          .optional(),
      }),
    )
    .max(30)
    .optional(),
  reports: z.strictObject({
    weekly_day: Weekday,
    send_to: z.array(z.email('must be an email address')),
    /** Also send a one-line summary on WhatsApp to these numbers (E.164, e.g. +919876543210). */
    whatsapp_to: z
      .array(z.string().regex(/^\+[1-9]\d{9,14}$/, 'use the international format, e.g. +919876543210'))
      .max(5)
      .optional(),
    avg_transaction_value: z.number().min(0),
    currency: z.literal('INR'),
  }),
});

export type TenantConfig = z.infer<typeof TenantConfigSchema>;

export const AUTONOMY_DEFAULTS: Record<AutonomyAction, AutonomyMode> = {
  faq: 'auto',
  book: 'auto',
  reschedule: 'auto',
  cancel: 'auto',
  remind: 'auto',
  follow_up: 'auto',
  waitlist_offer: 'auto',
  reactivate: 'auto',
  payment_reminder: 'auto',
};
export const autonomyOf = (config: TenantConfig, action: AutonomyAction): AutonomyMode =>
  config.autonomy?.[action] ?? AUTONOMY_DEFAULTS[action];

export const JOURNEY_DEFAULTS: NonNullable<TenantConfig['journeys']> = {
  stall_grace_days: 7,
  recall_months: 6,
  lost_lead_after_hours: 48,
  max_outreach_per_day: 30,
  waitlist_offer_minutes: 30,
  waitlist_batch: 3,
};
export const journeysOf = (config: TenantConfig) => ({ ...JOURNEY_DEFAULTS, ...config.journeys });

/** What the phone agent says first when the clinic has not written its own disclosure. */
export const DEFAULT_CALL_DISCLOSURE =
  'Hello, you have reached {{business_name}}. I am the virtual assistant and can help with appointments.';

/** The phone agent's settings, or null when it is off (the product then behaves exactly as without it). */
export const voiceOf = (config: TenantConfig) => (config.voice?.enabled ? config.voice : null);
export type Language = z.infer<typeof Language>;

/** Default opt-in keywords: "START" is the WhatsApp convention. One-word ones must be the whole message. */
export const DEFAULT_OPT_IN_KEYWORDS = [
  'start',
  'subscribe',
  'resume',
  'start messages',
  'start messaging',
  'opt in',
  'send messages',
  'shuru karo',
  'message bhejo',
  'शुरू',
  'शुरू करो',
  'मैसेज भेजो',
];

/** Default opt-out keywords (English, Hinglish, Hindi). One-word ones must be the whole message. */
export const DEFAULT_OPT_OUT_KEYWORDS = [
  'stop',
  'unsubscribe',
  'stop messages',
  'stop messaging',
  'opt out',
  'band karo',
  'message band karo',
  'mat bhejo',
  'बंद',
  'बंद करो',
  'मैसेज बंद करो',
  'मत भेजो',
];
