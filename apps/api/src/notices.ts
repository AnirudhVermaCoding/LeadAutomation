import { fillVariables } from '@instantlead/config';
import { eq } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { leads } from './db/schema.ts';
import type { JobData } from './jobs.ts';
import { sendToLead, type MessagingDeps } from './outbound.ts';

type Lang = 'en' | 'hi' | 'hinglish';

/** Fixed replies to "STOP" and "START": the customer just wrote, so the chat window is open. */
const TEXT: Record<JobData['lead-notice']['kind'], Record<Lang, string>> = {
  opt_out_confirmed: {
    en: "You're unsubscribed from {{business_name}} messages and we won't message you again. If you change your mind, just reply START.",
    hi: 'आप {{business_name}} के मैसेज से अनसब्सक्राइब हो गए हैं और हम आपको दोबारा मैसेज नहीं भेजेंगे। मन बदले तो बस START लिखकर भेजें।',
    hinglish:
      'Aap {{business_name}} ke messages se unsubscribe ho gaye hain, ab hum aapko message nahi bhejenge. Mann badle toh bas START likh dijiye.',
  },
  opt_in_confirmed: {
    en: "Welcome back! You'll hear from {{business_name}} again. How can we help you?",
    hi: 'वापस स्वागत है! अब आपको {{business_name}} से मैसेज मिलेंगे। हम आपकी कैसे मदद कर सकते हैं?',
    hinglish:
      'Welcome back! Ab aapko {{business_name}} se messages milenge. Hum aapki kaise madad kar sakte hain?',
  },
};

/** Confirmation after someone opts out or back in. The only message ever sent to an opted-out number (the confirmation itself). */
export async function sendLeadNotice(deps: MessagingDeps, job: JobData['lead-notice']) {
  const loaded = await withTenant(deps.db, job.tenantId, async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, job.leadId));
    const config = (await getActiveConfig(tx))?.config;
    return lead && config ? { lead, config } : null;
  });
  if (!loaded) return { skipped: 'lead gone' };
  const { lead, config } = loaded;
  const lang = (lead.language ?? config.brand.default_language) as Lang;
  const template =
    job.kind === 'opt_out_confirmed' && config.intake.opt_out_confirmation
      ? config.intake.opt_out_confirmation
      : (TEXT[job.kind][lang] ?? TEXT[job.kind].en);
  return sendToLead(deps, job.tenantId, {
    leadId: job.leadId,
    idempotencyKey: `notice:${job.kind}:${job.key}`,
    allowOptedOut: job.kind === 'opt_out_confirmed',
    freeForm: { kind: 'text', body: fillVariables(template, { business_name: config.brand.business_name }) },
  });
}
