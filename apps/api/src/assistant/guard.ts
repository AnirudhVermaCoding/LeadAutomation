/**
 * Deterministic guardrails around the model. Pure functions: no I/O, no LLM.
 * - inbound: normalize text, media handling, obvious junk, flood signals, redaction
 * - outbound: clean every reply and check it against hard rules before it is sent
 */

import type { MediaType } from '@instantlead/integrations';

export type Lang = 'en' | 'hi' | 'hinglish';
const pick = <T>(lang: string | null | undefined, m: Record<Lang, T>) => m[(lang as Lang) ?? 'en'] ?? m.en;

// ---------------------------------------------------------------- inbound

const MAX_INBOUND_CHARS = 1500;
/** Control, zero-width and bidi-override characters: [start, end] code points. */
const INVISIBLE_RANGES: [number, number][] = [
  [0x0, 0x8],
  [0xb, 0xc],
  [0xe, 0x1f],
  [0x7f, 0x7f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
];
const hex = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`;
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${hex(a)}-${hex(b)}`).join('')}]`, 'g');

/** Strip control / zero-width characters, collapse character floods, cap the length. */
export function normalizeInbound(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(/(.)\1{9,}/gu, '$1$1$1$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_INBOUND_CHARS);
}

/**
 * Media without usable text is answered without the AI (photos and voice notes are never sent
 * to a model). Captions are treated as text by the caller.
 */
export function mediaResponse(
  type: MediaType,
  lang: string | null,
  /** Clinics: "the doctor will look at it"; others: "the team will take a look". */
  clinic = true,
): { reply: string | null; alertStaff: boolean } {
  switch (type) {
    case 'image':
    case 'video':
    case 'document':
      return {
        reply: !clinic
          ? pick(lang, {
              en: 'Thanks for sending that — I have passed it to the team and they will take a look. Is there anything I can help you with meanwhile?',
              hi: 'भेजने के लिए धन्यवाद — मैंने इसे टीम को भेज दिया है, वे इसे देखेंगे। तब तक क्या मैं आपकी कोई मदद कर सकती हूँ?',
              hinglish:
                'Bhejne ke liye thanks — maine team ko forward kar diya hai, woh dekh lenge. Tab tak main aapki kya madad kar sakti hoon?',
            })
          : pick(lang, {
              en: 'Thanks for sharing that — our doctor will look at it properly at your visit. Would you like me to find you a time to come in?',
              hi: 'भेजने के लिए धन्यवाद — डॉक्टर इसे आपकी विज़िट पर ठीक से देखेंगे। क्या मैं आपके लिए अपॉइंटमेंट का समय ढूंढूं?',
              hinglish:
                'Bhejne ke liye thanks — doctor ise aapki visit par achhe se dekhenge. Kya main aapke liye appointment ka time dhoondh doon?',
            }),
        alertStaff: true,
      };
    case 'audio':
      return {
        reply: pick(lang, {
          en: "Sorry, I can't play voice notes here. Could you type your question? Or if you prefer, I can ask the team to call you.",
          hi: 'माफ़ कीजिए, मैं यहाँ वॉइस नोट नहीं सुन सकती। क्या आप अपना सवाल लिखकर भेज सकते हैं? या मैं टीम से आपको कॉल करवा दूँ?',
          hinglish:
            'Sorry, main yahan voice note nahi sun sakti. Kya aap apna sawaal type kar denge? Ya main team se aapko call karwa doon?',
        }),
        alertStaff: true,
      };
    case 'location':
    case 'contacts':
      return {
        reply: pick(lang, {
          en: 'Thanks, got it! How can I help you today?',
          hi: 'धन्यवाद, मिल गया! मैं आपकी क्या मदद कर सकती हूँ?',
          hinglish: 'Thanks, mil gaya! Main aapki kya madad kar sakti hoon?',
        }),
        alertStaff: false,
      };
    case 'sticker':
    case 'reaction':
      return { reply: null, alertStaff: false };
  }
}

// Not Emoji_Component: digits are emoji components (keycaps), and "2" is a real answer.
const EMOJI_ONLY =
  /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Variation_Selector}\p{Join_Control}\p{P}\s]+$/u;
export const isEmojiOnly = (text: string) => text.trim() !== '' && EMOJI_ONLY.test(text.trim());

// ---------------------------------------------------------------- junk (not a real enquiry)

export const NOT_A_LEAD = ['wrong_number', 'vendor', 'job_seeker', 'spam', 'auto_reply'] as const;
export type NotALead = (typeof NOT_A_LEAD)[number];
export type IntentCategory = 'genuine' | NotALead;

const RULES: { category: NotALead; re: RegExp; certain?: boolean }[] = [
  {
    category: 'auto_reply',
    certain: true,
    re: /(this is an? (automated|auto[- ]?generated) (message|reply|response)|auto[- ]?reply|out of (the )?office|i am (currently )?(away|unavailable|on leave)|thank you for (contacting|reaching|messaging) .{0,40}(we|our team) will (get back|respond|reply)|do not reply to this)/i,
  },
  {
    category: 'spam',
    certain: true,
    re: /(https?:\/\/|www\.)\S+.*\b(seo|backlinks?|loan|crypto|bitcoin|forex|casino|betting|lottery|earn \S+ (daily|per day)|investment plan|work from home)\b|\b(seo|backlinks?|loan|crypto|bitcoin|forex|casino|lottery)\b.*(https?:\/\/|www\.)\S+/is,
  },
  {
    category: 'vendor',
    re: /\b(we (provide|offer)|our (company|agency|services)|seo services|digital marketing|website (design|development)|google ranking|social media management|lead generation services|partnership opportunity|collaborat(e|ion)|supplier|distributor|dealership)\b/i,
  },
  {
    category: 'job_seeker',
    // Application intent, not just the word "job" ("write me a cover letter for a job" is off-topic, not a job seeker).
    re: /\b(vacanc(y|ies)|job (opening|vacancy|opportunity)|any (job|opening)s?|are you hiring|my (resume|cv)\b|send (my |you my )?(resume|cv)\b|internship|naukri chahiye|apply for (the |a )?(job|post|position)|looking for (a )?(job|work)|(receptionist|nurse|assistant) (post|job))\b/i,
  },
  {
    category: 'wrong_number',
    re: /\b(wrong number|who is this|who are you guys|galat number|kaun bol raha|i didn'?t (contact|message|enquire)|not interested,? (i )?never)\b/i,
  },
  { category: 'spam', re: /\b(crypto|bitcoin|forex|casino|lottery|betting tips|earn money fast)\b/i },
];

/** Deterministic classification: the obvious cases (and the mock-mode classifier). */
export function ruleBasedIntent(text: string): { category: IntentCategory; confidence: number } {
  for (const r of RULES)
    if (r.re.test(text)) return { category: r.category, confidence: r.certain ? 0.97 : 0.85 };
  return { category: 'genuine', confidence: 0.9 };
}

/** Anything that sounds like a patient or a booking keeps the lead genuine, whatever the classifier says. */
export function hasCustomerSignal(text: string, serviceWords: string[]): boolean {
  const t = text.toLowerCase();
  if (
    /\b(appointment|book|slot|consult|doctor|dr\b|treatment|pain|dard|tooth|teeth|daant|skin|hair|price|cost|fee|kitna|visit|clinic|checkup|check up|flat|bhk|site visit|property)\b/i.test(
      t,
    )
  )
    return true;
  return serviceWords
    .flatMap((s) => s.toLowerCase().split(/[^\p{L}]+/u))
    .some((w) => w.length > 3 && t.includes(w));
}

export function notALeadReply(category: NotALead, businessName: string, lang: string | null): string | null {
  switch (category) {
    case 'wrong_number':
      return pick(lang, {
        en: `No problem — this is ${businessName}. Sorry for the mix-up, have a good day!`,
        hi: `कोई बात नहीं — यह ${businessName} है। गलतफहमी के लिए माफ़ी, आपका दिन शुभ हो!`,
        hinglish: `Koi baat nahi — yeh ${businessName} hai. Mix-up ke liye sorry, aapka din achha ho!`,
      });
    case 'vendor':
      return pick(lang, {
        en: `Thanks for reaching out. This number is for customer enquiries; for business proposals please email ${businessName} directly.`,
        hi: `संपर्क करने के लिए धन्यवाद। यह नंबर ग्राहकों की पूछताछ के लिए है; व्यावसायिक प्रस्ताव कृपया ${businessName} को ईमेल करें।`,
        hinglish: `Contact karne ke liye thanks. Yeh number customers ki enquiries ke liye hai; business proposals ke liye please ${businessName} ko email karein.`,
      });
    case 'job_seeker':
      return pick(lang, {
        en: `Thanks for your interest in working with ${businessName}! This number is for customer enquiries, so please email your CV to the office directly.`,
        hi: `${businessName} में काम करने में रुचि के लिए धन्यवाद! यह नंबर ग्राहकों के लिए है, कृपया अपना CV ऑफ़िस को सीधे ईमेल करें।`,
        hinglish: `${businessName} ke saath kaam karne mein interest ke liye thanks! Yeh number customers ke liye hai, please apna CV office ko seedha email karein.`,
      });
    case 'spam':
    case 'auto_reply':
      return null; // silence
  }
}

// ---------------------------------------------------------------- redaction

/** Direct identifiers no AI task needs: phone numbers, emails, Aadhaar- and PAN-like ids. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[id number]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id number]')
    .replace(/(\+?\d[\d\s-]{8,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[phone]' : m));
}

// ---------------------------------------------------------------- outbound

export const MAX_REPLY_CHARS = 700;

/** WhatsApp shows plain text: drop markdown, keep the words; cap the length at a sentence end. */
export function cleanReply(text: string): string {
  let t = text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > MAX_REPLY_CHARS) {
    const cut = t.slice(0, MAX_REPLY_CHARS);
    const end = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('।'),
    );
    t = end > 200 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return t;
}

const LEAK =
  /\b(record_answer|lookup_knowledge|escalate_to_human|mark_disqualified|get_available_slots|book_slot|join_waitlist|tool_use|CRM state|QUALIFICATION QUESTIONS|system prompt|my instructions|Do not guess|Internal note)\b|\bKNOWLEDGE\b/;
const MEDICINE =
  /\b(paracetamol|ibuprofen|crocin|combiflam|dolo|calpol|aspirin|diclofenac|nimesulide|amoxicillin|azithromycin|metronidazole|cetirizine|antibiotics?|painkillers?|\d+\s?mg)\b/i;
/**
 * Clinical interpretation the assistant must never give (diagnosis, treatment decisions, "it's nothing serious").
 * Narrow on purpose: naming a bookable service ("a root canal consultation") is fine; telling someone they need one is not.
 */
const CLINICAL =
  /\b(you (probably |likely |may |might |definitely |surely )?(have|need|are suffering from|have got) (a |an |some )?(cavity|cavities|infection|abscess|gum disease|gingivitis|periodontitis|root canal|extraction|tooth removal|filling|crown|implant|surgery|tumou?r|cancer|fracture)|(it|this|that) (sounds|looks|seems) like (a |an )?(cavity|infection|abscess|gum disease|gingivitis|decay|fracture|ulcer)|(it|this|that)('s| is| isn't| is not) (nothing serious|not serious|serious|dangerous|nothing to worry about)|no need to (see|visit) (a |the )?(doctor|dentist)|(take|apply|use|gargle with) (some |a )?(clove oil|salt water|warm water|ice|turmeric|antiseptic|mouthwash))\b/i;
const DEVANAGARI = /[ऀ-ॿ]/gu;
const LETTERS = /\p{L}/gu;
const numbers = (s: string) => new Set([...s.matchAll(/\d[\d,]*/g)].map((m) => m[0].replace(/,/g, '')));

export interface ReplyContext {
  /** Knowledge text + this turn's tool results: the only places facts may come from. */
  sources: string;
  /** URLs the reply may contain (review link, maps…), besides any in the sources. */
  allowedUrls: string[];
  /** Clinics: no medicine names or doses. */
  noMedicalAdvice: boolean;
  /** The lead's language, when known. */
  language: string | null;
}

/** Hard rules every reply must pass. Returns the problems (empty = fine). */
/** A rupee amount as checkReply reads one ("₹1,500", "Rs 500", "1500 rupees", "500/-"). */
export const PRICE = /(?:₹|rs\.?|inr)\s?(\d[\d,]*)|(\d[\d,]*)\s?(?:rupees|rs\b|\/-)/gi;

export function checkReply(text: string, c: ReplyContext): string[] {
  const problems: string[] = [];
  if (LEAK.test(text)) problems.push('mentions internal instructions or tool names');

  const known = numbers(c.sources);
  for (const m of text.matchAll(PRICE)) {
    const amount = (m[1] ?? m[2] ?? '').replace(/,/g, '');
    if (amount && !known.has(amount))
      problems.push(`states a price (₹${amount}) that is not in the business's information`);
  }

  if (c.noMedicalAdvice && MEDICINE.test(text))
    problems.push('names a medicine or dose (no medical advice allowed)');
  if (c.noMedicalAdvice && CLINICAL.test(text))
    problems.push('gives a diagnosis, treatment decision or home remedy (clinical advice is never allowed)');

  const allowed = [...c.allowedUrls, ...(c.sources.match(/https?:\/\/\S+|www\.\S+/g) ?? [])].map((u) =>
    u.replace(/[).,]+$/, '').toLowerCase(),
  );
  for (const u of text.match(/https?:\/\/\S+|www\.\S+/g) ?? [])
    if (
      !allowed.some(
        (a) => u.toLowerCase().startsWith(a) || a.startsWith(u.replace(/[).,]+$/, '').toLowerCase()),
      )
    )
      problems.push(`contains a link that is not the business's own (${u})`);

  const sourceDigits = c.sources.replace(/\D/g, '');
  for (const p of text.match(/\+?\d[\d\s-]{8,}\d/g) ?? []) {
    const digits = p.replace(/\D/g, '');
    if (digits.length >= 10 && !sourceDigits.includes(digits.slice(-10)))
      problems.push('contains a phone number that is not the business’s own');
  }

  const letters = text.match(LETTERS)?.length ?? 0;
  if (letters >= 20 && c.language) {
    const share = (text.match(DEVANAGARI)?.length ?? 0) / letters;
    if (c.language === 'hi' && share < 0.3)
      problems.push('the customer writes in Hindi (Devanagari) but the reply is not');
    if (c.language !== 'hi' && share > 0.5)
      problems.push('the reply is in Devanagari but the customer writes in Roman script');
  }
  return [...new Set(problems)];
}

/** The same question again and again means the conversation is stuck. */
export const sameReply = (a: string, b: string) =>
  a
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim() ===
  b
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
