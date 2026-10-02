import type { TEMPLATE_VARIABLES } from './validate.ts';

/** Languages templates are submitted in. Hinglish leads get the English template; free-form replies match their style. */
export const TEMPLATE_LANGUAGES = ['en', 'hi'] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

export type TemplateCategory = 'utility' | 'marketing';
type Variable = (typeof TEMPLATE_VARIABLES)[number];
type Text = Record<TemplateLanguage, string>;

export interface TemplateDef {
  /** Name submitted to Meta (lowercase + underscores). Tenants can override per language. */
  providerName: string;
  category: TemplateCategory;
  /** Who receives it and when — shown in TEMPLATES-TO-SUBMIT.md. */
  purpose: string;
  /** Order = {{1}}, {{2}}, … in the body. */
  variables: Variable[];
  body: Text;
  /** Quick-reply buttons; tapping one sends back the payload `<key>:<id>`. Max 3. */
  buttons: { id: string; text: Text }[];
}

const STOP = { id: 'stop', text: { en: 'Stop messages', hi: 'मैसेज बंद करें' } };
const CONFIRM = { id: 'confirm', text: { en: 'Confirm', hi: 'कन्फ़र्म करें' } };
const RESCHEDULE = { id: 'reschedule', text: { en: 'Reschedule', hi: 'समय बदलें' } };
const CANCEL = { id: 'cancel', text: { en: 'Cancel', hi: 'रद्द करें' } };
const YES = { id: 'yes', text: { en: 'Yes, please', hi: 'हाँ, ज़रूर' } };
const SHOW_TIMES = { id: 'times', text: { en: 'Show new times', hi: 'नए समय दिखाएँ' } };
const REBOOK = { id: 'rebook', text: { en: 'Book a new time', hi: 'नया समय बुक करें' } };
const CALL_ME = { id: 'call', text: { en: 'Call me', hi: 'मुझे कॉल करें' } };

export const TEMPLATES = {
  first_reply: {
    providerName: 'il_first_reply',
    category: 'utility',
    purpose: 'Instant reply (< 60 s) to a lead who submitted a form or lead ad.',
    variables: ['first_name', 'business_name', 'assistant_name'],
    body: {
      en: 'Hi {{1}}, thanks for your enquiry with {{2}}! I am {{3}}, their assistant. Can I ask you 2-3 quick questions to help you book a visit?',
      hi: 'नमस्ते {{1}}, {{2}} से संपर्क करने के लिए धन्यवाद! मैं {{3}} हूँ, उनकी असिस्टेंट। क्या आपकी विज़िट बुक करने के लिए मैं 2-3 छोटे सवाल पूछ सकती हूँ?',
    },
    buttons: [
      { id: 'yes', text: { en: 'Yes, go ahead', hi: 'हाँ, पूछिए' } },
      { id: 'call', text: { en: 'Please call me', hi: 'मुझे कॉल करें' } },
      STOP,
    ],
  },
  followup_day2: {
    providerName: 'il_followup_day2',
    category: 'marketing',
    purpose: 'Day-2 follow-up to a lead who has not replied.',
    variables: ['first_name', 'business_name'],
    body: {
      en: 'Hi {{1}}, just checking in from {{2}}. Would you still like help booking your visit?',
      hi: 'नमस्ते {{1}}, {{2}} की ओर से याद दिला रहे हैं। क्या आप अब भी अपनी विज़िट बुक करना चाहेंगे?',
    },
    buttons: [YES, STOP],
  },
  followup_day5: {
    providerName: 'il_followup_day5',
    category: 'marketing',
    purpose: 'Day-5 last follow-up before the lead is marked unresponsive.',
    variables: ['first_name', 'business_name'],
    body: {
      en: 'Hi {{1}}, this is our last check-in from {{2}}. Reply any time if you would like to book - we are happy to help.',
      hi: 'नमस्ते {{1}}, {{2}} की ओर से यह आख़िरी रिमाइंडर है। बुक करना हो तो कभी भी जवाब दें - हम मदद के लिए तैयार हैं।',
    },
    buttons: [YES, STOP],
  },
  booking_confirmed: {
    providerName: 'il_booking_confirmed',
    category: 'utility',
    purpose: 'Appointment confirmed (auto-confirm mode, or after staff approval).',
    variables: ['first_name', 'appointment.service', 'business_name', 'appointment.time'],
    body: {
      en: 'Hi {{1}}, your {{2}} at {{3}} is confirmed for {{4}}.',
      hi: 'नमस्ते {{1}}, {{3}} में आपकी {{2}} {{4}} के लिए कन्फ़र्म है।',
    },
    buttons: [RESCHEDULE, CANCEL],
  },
  booking_pending: {
    providerName: 'il_booking_pending',
    category: 'utility',
    purpose: 'Booking request received; waiting for staff to confirm (staff-confirm mode).',
    variables: ['first_name', 'appointment.service', 'appointment.time', 'business_name'],
    body: {
      en: 'Hi {{1}}, we have received your request for {{2}} on {{3}}. {{4}} will confirm it shortly.',
      hi: 'नमस्ते {{1}}, {{3}} को {{2}} के लिए आपका अनुरोध मिल गया है। {{4}} जल्द ही इसे कन्फ़र्म करेगा।',
    },
    buttons: [],
  },
  reminder_24h: {
    providerName: 'il_reminder_24h',
    category: 'utility',
    purpose: 'Reminder 24 hours before the appointment.',
    variables: ['first_name', 'appointment.service', 'business_name', 'appointment.time'],
    body: {
      en: 'Reminder: {{1}}, your {{2}} at {{3}} is tomorrow at {{4}}.',
      hi: 'रिमाइंडर: {{1}}, {{3}} में आपकी {{2}} कल {{4}} बजे है।',
    },
    buttons: [CONFIRM, RESCHEDULE, CANCEL],
  },
  reminder_2h: {
    providerName: 'il_reminder_2h',
    category: 'utility',
    purpose: 'Reminder 2 hours before the appointment.',
    variables: ['first_name', 'appointment.service', 'business_name', 'appointment.time'],
    body: {
      en: 'See you soon, {{1}}! Your {{2}} at {{3}} is at {{4}} today.',
      hi: 'जल्द मिलते हैं, {{1}}! {{3}} में आपकी {{2}} आज {{4}} बजे है।',
    },
    buttons: [CONFIRM, RESCHEDULE, CANCEL],
  },
  no_show_recovery: {
    providerName: 'il_no_show_recovery',
    category: 'utility',
    purpose: 'Sent after staff mark a missed appointment.',
    variables: ['first_name', 'business_name'],
    body: {
      en: 'Hi {{1}}, we missed you today at {{2}}. Would you like to pick a new time?',
      hi: 'नमस्ते {{1}}, आज {{2}} में हम आपका इंतज़ार कर रहे थे। क्या आप नया समय चुनना चाहेंगे?',
    },
    buttons: [{ id: 'reschedule', text: { en: 'Pick a new time', hi: 'नया समय चुनें' } }, STOP],
  },
  review_request: {
    providerName: 'il_review_request',
    category: 'marketing',
    purpose: 'Sent after staff mark a visit completed.',
    variables: ['first_name', 'business_name', 'review_link'],
    body: {
      en: 'Thank you for visiting {{2}}, {{1}}! Could you spare a minute to share a review? {{3}}',
      hi: '{{2}} आने के लिए धन्यवाद, {{1}}! क्या आप एक मिनट निकालकर रिव्यू दे सकते हैं? {{3}}',
    },
    buttons: [],
  },
  staff_new_booking: {
    providerName: 'il_staff_new_booking',
    category: 'utility',
    purpose: 'To clinic staff: a new booking or booking request needs attention.',
    variables: ['first_name', 'appointment.service', 'appointment.time'],
    body: {
      en: 'New booking request: {{1}} for {{2}} on {{3}}. Open the InstantLead dashboard to confirm.',
      hi: 'नई बुकिंग: {{1}}, {{2}}, {{3}}। कन्फ़र्म करने के लिए InstantLead डैशबोर्ड खोलें।',
    },
    buttons: [],
  },
  staff_handover: {
    providerName: 'il_staff_handover',
    category: 'utility',
    purpose:
      'To clinic staff: a conversation needs a person (handover, emergency, photo or voice note received).',
    variables: ['first_name'],
    body: {
      en: '{{1}} needs a reply from the team on WhatsApp. Open the InstantLead inbox to see the conversation.',
      hi: '{{1}} को टीम से WhatsApp पर जवाब चाहिए। बातचीत देखने के लिए InstantLead इनबॉक्स खोलें।',
    },
    buttons: [],
  },
  appointment_change: {
    providerName: 'il_appointment_change',
    category: 'utility',
    purpose:
      'The booked time can no longer go ahead (doctor / agent unavailable, closure); offers new times.',
    variables: ['first_name', 'appointment.service', 'appointment.time', 'business_name'],
    body: {
      en: 'Hi {{1}}, we are sorry: your {{2}} on {{3}} at {{4}} cannot go ahead as planned because of an unexpected change on our side. Tap below and we will find you a new time straight away.',
      hi: 'नमस्ते {{1}}, हमें खेद है: {{4}} में {{3}} को आपकी {{2}} हमारी ओर से अचानक बदलाव के कारण तय समय पर नहीं हो पाएगी। नीचे टैप करें, हम तुरंत नया समय ढूंढ देंगे।',
    },
    buttons: [SHOW_TIMES, CALL_ME],
  },
  cancellation: {
    providerName: 'il_cancellation',
    category: 'utility',
    purpose:
      'The appointment was cancelled (by staff, or at the customer request) and the 24-hour chat window is closed, so a plain message cannot be sent.',
    variables: ['first_name', 'appointment.service', 'appointment.time', 'business_name'],
    body: {
      en: 'Hi {{1}}, your {{2}} on {{3}} at {{4}} has been cancelled. If you would like a new time, tap below and we will find one for you.',
      hi: 'नमस्ते {{1}}, {{4}} में {{3}} को आपकी {{2}} रद्द कर दी गई है। नया समय चाहिए तो नीचे टैप करें, हम आपके लिए ढूंढ देंगे।',
    },
    buttons: [REBOOK],
  },
  running_late: {
    providerName: 'il_running_late',
    category: 'utility',
    purpose: 'Sent by staff from Today when the doctor / agent is running late.',
    variables: ['first_name', 'business_name', 'delay_minutes', 'appointment.time'],
    body: {
      en: 'Hi {{1}}, a quick heads-up from {{2}}: we are running about {{3}} minutes late today, so your {{4}} appointment may start a little later. Reply here if you would like to change it.',
      hi: 'नमस्ते {{1}}, {{2}} की ओर से सूचना: आज हम लगभग {{3}} मिनट देरी से चल रहे हैं, इसलिए आपकी {{4}} की अपॉइंटमेंट थोड़ी देर से शुरू हो सकती है। बदलना हो तो यहाँ जवाब दें।',
    },
    buttons: [],
  },
  staff_update: {
    providerName: 'il_staff_update',
    category: 'utility',
    purpose:
      'To staff: something needs a look (unconfirmed booking or reminder, auto-confirmed booking, unmarked visits).',
    variables: ['note'],
    body: {
      en: 'Update from your WhatsApp assistant: {{1}}. Open the InstantLead dashboard for details.',
      hi: 'आपके WhatsApp असिस्टेंट से अपडेट: {{1}}। विवरण के लिए InstantLead डैशबोर्ड खोलें।',
    },
    buttons: [],
  },
} as const satisfies Record<string, TemplateDef>;

export type TemplateKey = keyof typeof TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];

/** Fill {{1}}…{{n}} positionally (used for previews, the fake channel and the inbox). */
export function renderTemplateBody(
  key: TemplateKey,
  language: TemplateLanguage,
  values: readonly string[],
): string {
  return TEMPLATES[key].body[language].replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => values[Number(n) - 1] ?? '',
  );
}

/**
 * Payload WhatsApp returns when a quick-reply button is tapped: `<template>:<button>`, plus the
 * appointment it is about (`:<appointment id>`), so a customer with several bookings acts on the right one.
 */
export const buttonPayload = (key: TemplateKey, buttonId: string, appointmentId?: string) =>
  appointmentId ? `${key}:${buttonId}:${appointmentId}` : `${key}:${buttonId}`;

export function parseButtonPayload(
  payload: string,
): { key: TemplateKey; buttonId: string; appointmentId?: string } | null {
  const [key, buttonId, appointmentId] = payload.split(':');
  return key && buttonId && key in TEMPLATES
    ? { key: key as TemplateKey, buttonId, ...(appointmentId ? { appointmentId } : {}) }
    : null;
}
