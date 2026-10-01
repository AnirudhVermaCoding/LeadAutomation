import { DEFAULT_OPT_OUT_KEYWORDS, type TenantConfig } from '../schema.ts';

export const CLINIC_VARIANTS = ['dental', 'skin', 'hair'] as const;
export type ClinicVariant = (typeof CLINIC_VARIANTS)[number];

type VariantParts = Pick<TenantConfig['booking'], 'services'> & {
  treatments: string[];
  knowledge: TenantConfig['qualification']['knowledge'];
  avg_transaction_value: number;
};

const SAMPLE = 'SAMPLE — replace during onboarding.';

const VARIANTS: Record<ClinicVariant, VariantParts> = {
  dental: {
    treatments: ['checkup_cleaning', 'tooth_pain', 'root_canal', 'whitening', 'braces_aligners', 'implants'],
    services: [
      { name: 'Consultation', duration_minutes: 20 },
      { name: 'Cleaning & polishing', duration_minutes: 45 },
      { name: 'Root canal consultation', duration_minutes: 30 },
      { name: 'Teeth whitening', duration_minutes: 60 },
      { name: 'Braces / aligners consultation', duration_minutes: 30 },
    ],
    knowledge: [
      {
        title: 'Prices',
        content: `${SAMPLE} Consultation ₹500 (adjusted in treatment). Cleaning ₹1,500. Whitening from ₹8,000. Root canal and braces are priced after the dentist examines you.`,
      },
    ],
    avg_transaction_value: 4000,
  },
  skin: {
    treatments: ['acne', 'pigmentation', 'anti_ageing', 'hair_removal', 'chemical_peel', 'other'],
    services: [
      { name: 'Dermatologist consultation', duration_minutes: 20 },
      { name: 'Chemical peel', duration_minutes: 45 },
      { name: 'Laser hair removal session', duration_minutes: 45 },
    ],
    knowledge: [
      {
        title: 'Prices',
        content: `${SAMPLE} Consultation ₹800. Chemical peel from ₹2,500 per session. Laser hair removal priced per area after consultation.`,
      },
    ],
    avg_transaction_value: 3500,
  },
  hair: {
    treatments: ['hair_fall', 'dandruff', 'prp', 'hair_transplant', 'other'],
    services: [
      { name: 'Trichologist consultation', duration_minutes: 30 },
      { name: 'PRP session', duration_minutes: 60 },
      { name: 'Hair transplant consultation', duration_minutes: 45 },
    ],
    knowledge: [
      {
        title: 'Prices',
        content: `${SAMPLE} Consultation ₹700. PRP from ₹4,000 per session. Transplants are quoted after a scalp assessment.`,
      },
    ],
    avg_transaction_value: 6000,
  },
};

export function clinicPreset(variant: ClinicVariant, businessName = 'Demo Clinic'): TenantConfig {
  // Copy so tenants cloned from the same preset never share (and mutate) arrays.
  const v = structuredClone(VARIANTS[variant]);
  return {
    schema_version: 1,
    brand: {
      business_name: businessName,
      assistant_name: 'Asha',
      tone: 'warm, polite and brief; like a helpful clinic receptionist',
      languages: ['en', 'hi', 'hinglish'],
      default_language: 'en',
    },
    locale: {
      timezone: 'Asia/Kolkata',
      business_hours: [
        { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], open: '10:00', close: '20:00' },
        { days: ['sun'], open: '10:00', close: '14:00' },
      ],
      quiet_hours: { start: '21:00', end: '09:00' },
    },
    intake: {
      sources: ['form', 'meta_lead_ads', 'click_to_whatsapp', 'api', 'csv'],
      consent_notice_text:
        'By submitting, you agree that {{business_name}} may contact you on WhatsApp, SMS or email about your enquiry and appointments. Reply STOP anytime to opt out.',
      opt_out_keywords: [...DEFAULT_OPT_OUT_KEYWORDS],
    },
    qualification: {
      max_turns: 8,
      questions: [
        {
          key: 'treatment_interest',
          hint: 'What treatment or problem they want help with',
          type: 'choice',
          options: v.treatments,
          required: true,
          weight: 3,
        },
        {
          key: 'urgency',
          hint: 'How soon they want to be seen',
          type: 'choice',
          options: ['today', 'this_week', 'this_month', 'just_exploring'],
          option_scores: { today: 1, this_week: 0.75, this_month: 0.4, just_exploring: 0 },
          required: true,
          weight: 4,
        },
        {
          key: 'location',
          hint: 'Which area of the city they are in',
          type: 'text',
          required: false,
          weight: 1,
        },
        {
          key: 'first_visit',
          hint: 'Whether this is their first visit',
          type: 'yes_no',
          required: false,
          weight: 1,
        },
        {
          key: 'preferred_time',
          hint: 'Morning, afternoon or evening',
          type: 'choice',
          options: ['morning', 'afternoon', 'evening'],
          required: false,
          weight: 1,
        },
      ],
      scoring: { hot: 7, warm: 4, disqualifiers: [] },
      knowledge: [
        ...v.knowledge,
        {
          title: 'Address and parking',
          content: `${SAMPLE} Address, landmark, Google Maps link and parking details go here.`,
        },
        { title: 'Doctors', content: `${SAMPLE} Doctor names, qualifications and days available go here.` },
        {
          title: 'Policies',
          content: `${SAMPLE} Payment modes, cancellation policy and what to bring to the first visit go here.`,
        },
      ],
      safety: {
        emergency_keywords: [
          'emergency',
          'severe pain',
          'bleeding',
          'swelling',
          'accident',
          'unconscious',
          'chest pain',
          'can’t breathe',
          "can't breathe",
          'bahut dard',
          'khoon',
          'saans nahi',
          'बहुत दर्द',
          'खून',
          'सांस',
        ],
        emergency_response:
          'This sounds urgent. Please call 112 or go to the nearest hospital emergency right away. I am also alerting the {{business_name}} team to call you.',
        no_medical_advice: true,
      },
    },
    booking: {
      slot_minutes: 15,
      buffer_minutes: 5,
      services: v.services,
      mode: 'staff_confirm',
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
      review_request: {
        enabled: true,
        after_hours: 3,
        google_review_link: 'https://g.page/r/REPLACE-WITH-CLINIC-REVIEW-ID/review',
      },
    },
    reports: {
      weekly_day: 'mon',
      send_to: ['owner@example.com'],
      avg_transaction_value: v.avg_transaction_value,
      currency: 'INR',
    },
  };
}
