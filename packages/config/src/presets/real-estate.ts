import { DEFAULT_OPT_OUT_KEYWORDS, type TenantConfig } from '../schema.ts';

const SAMPLE = 'SAMPLE — replace during onboarding.';

export function realEstatePreset(businessName = 'Demo Realty'): TenantConfig {
  return {
    schema_version: 1,
    brand: {
      business_name: businessName,
      assistant_name: 'Riya',
      tone: 'friendly, professional and to the point; like a good property advisor',
      languages: ['en', 'hi', 'hinglish'],
      default_language: 'en',
    },
    locale: {
      timezone: 'Asia/Kolkata',
      business_hours: [
        { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], open: '09:30', close: '19:30' },
      ],
      quiet_hours: { start: '21:00', end: '09:00' },
    },
    intake: {
      sources: ['form', 'meta_lead_ads', 'click_to_whatsapp', 'api', 'csv'],
      consent_notice_text:
        'By submitting, you agree that {{business_name}} may contact you on WhatsApp, SMS or email about properties and site visits. Replies may be written by an AI assistant (processed by Anthropic). Reply STOP anytime to opt out.',
      opt_out_keywords: [...DEFAULT_OPT_OUT_KEYWORDS],
    },
    qualification: {
      max_turns: 8,
      questions: [
        {
          key: 'budget_range',
          hint: 'Total budget',
          type: 'choice',
          options: ['under_40l', '40l_75l', '75l_1_5cr', 'above_1_5cr'],
          required: true,
          weight: 3,
        },
        { key: 'location', hint: 'Preferred localities', type: 'text', required: true, weight: 2 },
        {
          key: 'bhk',
          hint: 'Apartment size',
          type: 'choice',
          options: ['1bhk', '2bhk', '3bhk', '4bhk_plus', 'plot'],
          required: true,
          weight: 1,
        },
        {
          key: 'timeline',
          hint: 'When they plan to buy',
          type: 'choice',
          options: ['immediately', 'within_3_months', 'within_6_months', 'just_exploring'],
          option_scores: { immediately: 1, within_3_months: 0.75, within_6_months: 0.4, just_exploring: 0 },
          required: true,
          weight: 4,
        },
        {
          key: 'purpose',
          hint: 'Self use or investment',
          type: 'choice',
          options: ['self_use', 'investment'],
          required: false,
          weight: 1,
        },
        {
          key: 'loan_needed',
          hint: 'Whether they need a home loan',
          type: 'yes_no',
          required: false,
          weight: 0,
        },
      ],
      scoring: { hot: 8, warm: 5, disqualifiers: [{ question: 'budget_range', any_of: ['under_40l'] }] },
      knowledge: [
        {
          title: 'Projects',
          content: `${SAMPLE} Project names, locations, configurations, price ranges and possession dates go here.`,
        },
        {
          title: 'Site visits',
          content: `${SAMPLE} Site office address, pick-up/drop policy and timings go here.`,
        },
      ],
      safety: { emergency_keywords: [], emergency_response: '', no_medical_advice: false },
    },
    booking: {
      slot_minutes: 30,
      buffer_minutes: 15,
      services: [
        {
          name: 'Site visit',
          duration_minutes: 60,
          suitable_for: ['wants to see the property', 'shortlisted a flat', 'ready to decide soon'],
        },
        {
          name: 'Video walkthrough',
          duration_minutes: 30,
          suitable_for: ['lives in another city', 'busy on weekdays', 'early stage, just exploring'],
        },
      ],
      mode: 'auto_confirm',
      offer_slots: 3,
      staff_notify: { channel: 'whatsapp', to: '+910000000000' },
    },
    sequences: {
      followup: {
        steps: [
          { after_hours: 48, channel: 'email_or_whatsapp' },
          { after_hours: 120, channel: 'whatsapp' },
        ],
        stop_on: ['replied', 'booked', 'opted_out', 'disqualified'],
      },
      reminders: { before_hours: [24, 2] },
      no_show_recovery: { enabled: true, after_hours: 2 },
      review_request: { enabled: false, after_hours: 24 },
    },
    privacy: { retention_days: 365, mode: 'anonymize' },
    reports: {
      weekly_day: 'mon',
      send_to: ['owner@example.com'],
      avg_transaction_value: 100000,
      currency: 'INR',
    },
  };
}
