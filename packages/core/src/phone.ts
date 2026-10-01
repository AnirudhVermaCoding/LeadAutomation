const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalise a phone number to E.164. Bare 10-digit numbers are treated as Indian mobiles.
 * Returns null when the input can't be a valid number.
 * ponytail: India-first heuristics; switch to libphonenumber-js when other countries matter.
 */
export function toE164(raw: string, defaultCountryCode = '91'): string | null {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;

  let e164: string;
  if (trimmed.startsWith('+')) e164 = `+${digits}`;
  else if (digits.startsWith('00')) e164 = `+${digits.slice(2)}`;
  else {
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, ''); // trunk prefix, e.g. 098…
    if (defaultCountryCode === '91' && digits.length === 10) {
      if (!/^[6-9]/.test(digits)) return null; // Indian mobiles start with 6-9
      e164 = `+91${digits}`;
    } else if (digits.startsWith(defaultCountryCode) && digits.length > 10) e164 = `+${digits}`;
    else e164 = `+${defaultCountryCode}${digits}`;
  }
  return E164.test(e164) ? e164 : null;
}

/** WhatsApp `wa_id` / `from` values are E.164 without the plus. */
export const fromWaId = (waId: string) => toE164(`+${waId}`);
export const toWaId = (e164: string) => e164.replace(/^\+/, '');
