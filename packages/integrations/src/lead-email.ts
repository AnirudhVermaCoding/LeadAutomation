import { toE164 } from '@instantlead/core';

export interface InboundEmail {
  from?: string | undefined;
  subject?: string | undefined;
  text?: string | undefined;
  html?: string | undefined;
}

export interface ParsedLeadEmail {
  /** Which portal sent it (from the sender domain), if recognised. */
  portal: string | null;
  phone: string | null;
  name: string | null;
  email: string | null;
  message: string | null;
}

/** Sender domain -> portal name. Unknown senders still parse; the portal is just unknown. */
const PORTALS: [RegExp, string][] = [
  [/99acres/i, '99acres'],
  [/magicbricks/i, 'MagicBricks'],
  [/housing\.com/i, 'Housing.com'],
  [/practo/i, 'Practo'],
  [/justdial|jd\.in/i, 'JustDial'],
  [/sulekha/i, 'Sulekha'],
  [/nobroker/i, 'NoBroker'],
];

const LABELS = {
  name: /^(?:full\s+|customer\s+|buyer\s+|client\s+|contact\s+|patient\s+|lead\s+)?name$/i,
  phone: /^(?:mobile|mob|phone|contact|telephone|whatsapp|cell)(?:\s*(?:no\.?|number|num))?$/i,
  email: /^e-?mail(?:\s+(?:id|address))?$/i,
  message: /^(?:message|requirement|enquiry|inquiry|query|comments?|remarks?|looking\s+for|description)$/i,
};

const stripHtml = (html: string) =>
  html
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' : ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');

/**
 * Pull a lead out of a portal's "you have a new enquiry" email: labelled lines ("Name: Rohit Mehra",
 * "Mobile - +91 98765 43210", table rows), then any Indian mobile number in the body as a fallback.
 * Lenient on purpose: the exact layout differs by portal and changes over time. The email's own
 * From address is the portal's, never the customer's.
 */
export function parseLeadEmail(mail: InboundEmail): ParsedLeadEmail {
  const body = mail.text?.trim() ? mail.text : stripHtml(mail.html ?? '');
  const found: Partial<Record<keyof typeof LABELS, string>> = {};
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(/^\s*[*\-•>]*\s*([A-Za-z][A-Za-z .]{1,28}?)\s*[:\-–|]\s*(.+?)\s*$/);
    if (!m) continue;
    const label = m[1]!.trim();
    const value = m[2]!.replace(/[\s:|–-]+$/, '').trim();
    if (!value) continue;
    for (const [key, re] of Object.entries(LABELS) as [keyof typeof LABELS, RegExp][])
      if (re.test(label) && !found[key]) found[key] = value;
  }
  const phoneIn = (s: string | undefined) => {
    const m = s?.match(/(?:\+?91[\s-]?)?[6-9]\d(?:[\s-]?\d){8}/);
    return m ? toE164(m[0]) : null;
  };
  const email = found.email?.match(/[^\s<>()"']+@[^\s<>()"']+\.[A-Za-z]{2,}/)?.[0] ?? null;
  return {
    portal: PORTALS.find(([re]) => re.test(mail.from ?? ''))?.[1] ?? null,
    phone: phoneIn(found.phone) ?? phoneIn(body),
    name: found.name?.replace(/\s+/g, ' ').slice(0, 80) ?? null,
    email,
    message: found.message?.slice(0, 300) ?? null,
  };
}
