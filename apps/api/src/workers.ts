import { fillVariables } from '@instantlead/config';
import { runAssistantTurn } from './assistant/agent.ts';
import { ChannelError, fetchMetaLead } from '@instantlead/integrations';
import type { FastifyBaseLogger } from 'fastify';
import { getActiveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { QUEUES, type JobData } from './jobs.ts';
import { emit, intakeLead, transitionLeadIfAllowed } from './leads.ts';
import { sendToLead, type MessagingDeps } from './outbound.ts';
import { getTenantSecret } from './secrets.ts';
import type { AppContext } from './system/context.ts';

/** Day-0 reply to a form/lead-ad lead: always an approved template (the window isn't open yet). */
export async function sendFirstReply(deps: MessagingDeps, { tenantId, leadId }: JobData['first-reply']) {
  return sendToLead(deps, tenantId, {
    leadId,
    idempotencyKey: `first_reply:${leadId}`,
    template: { key: 'first_reply' },
    onSent: async (tx) => {
      await transitionLeadIfAllowed(tx, leadId, { type: 'FIRST_CONTACT_SENT' });
      await emit(tx, deps.clock, 'lead.contacted', { leadId });
    },
  });
}

/** Lead Ads webhook only carries an id: fetch the submission, then intake it like any other lead. */
export async function importMetaLead(
  deps: MessagingDeps,
  { tenantId, leadgenId, formId }: JobData['meta-leadgen'],
) {
  const token = await withTenant(deps.db, tenantId, (tx) =>
    getTenantSecret(tx, deps.secretsKey, tenantId, 'meta_page_access_token'),
  );
  if (!token)
    throw new ChannelError('Lead Ads is not connected (no page access token)', { retryable: false });
  const lead = await fetchMetaLead({ leadgenId, pageAccessToken: token, fetch: deps.fetch });
  if (!lead.phone) throw new ChannelError(`Lead ${leadgenId} has no phone number`, { retryable: false });
  const phone = lead.phone;

  return withTenant(deps.db, tenantId, async (tx) => {
    const active = await getActiveConfig(tx);
    if (!active) throw new Error('tenant has no config');
    const { brand, intake } = active.config;
    return intakeLead(tx, deps, tenantId, {
      phone,
      name: lead.name,
      email: lead.email,
      source: 'meta_lead_ads',
      sourceDetails: { leadgenId, formId: lead.formId ?? formId },
      consent: {
        source: 'meta_lead_ads',
        // The client adds this notice as the lead form's custom disclaimer (see ONBOARDING).
        noticeText: fillVariables(intake.consent_notice_text, {
          business_name: brand.business_name,
          assistant_name: brand.assistant_name,
        }),
        evidence: { leadgenId, formId: lead.formId ?? formId, createdTime: lead.createdTime },
      },
    });
  });
}

/** Permanent failures complete the job (they're recorded on the message); transient ones retry. */
async function runJob(log: FastifyBaseLogger, name: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    log.info({ job: name, result }, 'job done');
  } catch (err) {
    if (err instanceof ChannelError && !err.retryable) {
      log.warn({ job: name, err: err.message }, 'job failed permanently');
      return;
    }
    throw err;
  }
}

export async function startWorkers(ctx: AppContext, log: FastifyBaseLogger) {
  await ctx.boss.work<JobData['first-reply']>(QUEUES.firstReply, async (jobs) => {
    for (const job of jobs) await runJob(log, QUEUES.firstReply, () => sendFirstReply(ctx, job.data));
  });
  await ctx.boss.work<JobData['meta-leadgen']>(QUEUES.metaLeadgen, async (jobs) => {
    for (const job of jobs) await runJob(log, QUEUES.metaLeadgen, () => importMetaLead(ctx, job.data));
  });
  await ctx.boss.work<JobData['assistant-turn']>(QUEUES.assistantTurn, async (jobs) => {
    for (const job of jobs)
      await runJob(log, QUEUES.assistantTurn, () =>
        runAssistantTurn(ctx, job.data.tenantId, job.data.leadId),
      );
  });
}
