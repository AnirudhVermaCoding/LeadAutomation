export type DetectedLanguage = 'en' | 'hi' | 'hinglish';

const DEVANAGARI = /[ऀ-ॿ]/gu;
const LETTERS = /\p{L}/gu;

// Common Roman-script Hindi words that rarely appear in English sentences.
const HINGLISH = new Set(
  (
    'hai hain hoon hu ho tha thi kya kyu kyun kaise kaisa kab kahan kitna kitne kitni nahi nahin mat ' +
    'mujhe mera meri mere aap aapka aapki apna hum humko tum karna karo kar karke chahiye chahte ' +
    'sakte sakta sakti bata batao bataiye accha acha theek thik ji haan han kal aaj abhi wala wali ' +
    'liye ke ki ka se mein bhi bahut jaldi dard dant daant'
  ).split(' '),
);

/**
 * Cheap, deterministic language guess for a WhatsApp message (no LLM call):
 * Devanagari script -> hi; Roman script with several Hindi function words -> hinglish; else en.
 * ponytail: word-list heuristic; good enough to pick a reply language, swap for a classifier if it misfires.
 */
export function detectLanguage(text: string): DetectedLanguage | null {
  const letters = text.match(LETTERS)?.length ?? 0;
  if (letters < 3) return null; // emoji, "ok", numbers: keep the lead's previous language
  const devanagari = text.match(DEVANAGARI)?.length ?? 0;
  if (devanagari / letters > 0.3) return 'hi';
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hindiWords = words.filter((w) => HINGLISH.has(w)).length;
  return hindiWords >= 2 || (words.length <= 3 && hindiWords >= 1) ? 'hinglish' : 'en';
}
