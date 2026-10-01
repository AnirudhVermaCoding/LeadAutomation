import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:MM, e.g. "09:30"');
const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'use lowercase letters, digits and underscores, e.g. "treatment_interest"');
const nonEmpty = z.string().trim().min(1, 'cannot be empty');

export const LANGUAGES = ['en', 'hi', 'hinglish'] as const;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const INTAKE_SOURCES = ['form', 'meta_lead_ads', 'click_to_whatsapp', 'api', 'csv'] as const;

const Language = z.enum(LANGUAGES);
const Weekday = z.enum(WEEKDAYS);

const Question = z.object({
  key,
  hint: nonEmpty,
  type: z.enum(['text', 'choice', 'number', 'yes_no', 'date']),
  options: z.array(nonEmpty).optional(),
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
      no_medical_advice: z.boolean(),
    }),
  }),
  booking: z.strictObject({
    slot_minutes: z.int().min(5).max(240),
    buffer_minutes: z.int().min(0).max(120),
    services: z.array(z.strictObject({ name: nonEmpty, duration_minutes: z.int().min(5).max(480) })).min(1),
    mode: z.enum(['auto_confirm', 'staff_confirm']),
    offer_slots: z.int().min(1).max(5),
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
  reports: z.strictObject({
    weekly_day: Weekday,
    send_to: z.array(z.email('must be an email address')),
    avg_transaction_value: z.number().min(0),
    currency: z.literal('INR'),
  }),
});

export type TenantConfig = z.infer<typeof TenantConfigSchema>;
export type Language = z.infer<typeof Language>;

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
