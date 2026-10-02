import { fillVariables } from '@instantlead/config';
import { runAssistantTurn } from './assistant/agent.ts';
import { notifyAppointmentChange } from './notify.ts';
import { runMonitor } from './monitoring.ts';
import { runRetention } from './privacy.ts';
import { deliverWebhook, dispatchWebhookEvents } from './webhooks-out.ts';
import { runScheduledReports } from './reports.ts';
import { enrollFollowups, runStep, sweepDueSteps } from './sequences.ts';
import { ChannelError, fetchMetaLead } from '@instantlead/integrations';
import type { FastifyBaseLogger } from 'fastify';
import { getActiveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { ASSISTANT_RETRY_LIMIT, QUEUES, type JobData } from './jobs.ts';
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
      const config = (await getActiveConfig(tx))?.config;
      if (config) await enrollFollowups(tx, deps.clock, config, leadId);
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

/**
 * Per-item queues: poll every 0.5 s, take up to 10 jobs and keep fetching while batches come back
 * full, so a burst (100 form leads, or every follow-up released when quiet hours end) drains in
 * seconds. Per-job results: one failure retries only that job. First replies (independent leads)
 * run in parallel; everything else in order, so one lead's messages never overtake each other.
 */
async function workBatched<Q extends keyof JobData>(
  ctx: AppContext,
  log: FastifyBaseLogger,
  queue: Q,
  handler: (data: JobData[Q]) => Promise<unknown>,
  parallel = false,
) {
  const one = async (job: { id: string; data: JobData[Q] }) => {
    try {
      await runJob(log, queue, () => handler(job.data));
      return { id: job.id, status: 'completed' as const };
    } catch (err) {
      return { id: job.id, status: 'failed' as const, output: { message: String(err) } };
    }
  };
  await ctx.boss.work<JobData[Q]>(
    queue,
    { pollingIntervalSeconds: 0.5, batchSize: 10, burstWhenBatchFull: true, perJobResults: true },
    async (jobs) => {
      if (parallel) return Promise.all(jobs.map(one));
      const results = [];
      for (const job of jobs) results.push(await one(job));
      return results;
    },
  );
}

export async function startWorkers(ctx: AppContext, log: FastifyBaseLogger) {
  // The 60-second promise.
  await workBatched(ctx, log, QUEUES.firstReply, (d) => sendFirstReply(ctx, d), true);
  await workBatched(ctx, log, QUEUES.sequenceStep, (d) => runStep(ctx, d));
  await workBatched(ctx, log, QUEUES.appointmentNotify, (d) => notifyAppointmentChange(ctx, d));
  await workBatched(ctx, log, QUEUES.webhookDeliver, (d) => deliverWebhook(ctx, d));
  await ctx.boss.work<JobData['meta-leadgen']>(QUEUES.metaLeadgen, async (jobs) => {
    for (const job of jobs) await runJob(log, QUEUES.metaLeadgen, () => importMetaLead(ctx, job.data));
  });
  await ctx.boss.work(QUEUES.sequenceSweep, async () => {
    await runJob(log, QUEUES.sequenceSweep, async () => ({
      steps: await sweepDueSteps(ctx),
      webhookEvents: await dispatchWebhookEvents(ctx),
    }));
  });
  await ctx.boss.schedule(QUEUES.sequenceSweep, '* * * * *');
  await ctx.boss.work(QUEUES.reportsCron, async () => {
    await runJob(log, QUEUES.reportsCron, () => runScheduledReports(ctx));
  });
  await ctx.boss.schedule(QUEUES.reportsCron, '5 * * * *'); // hourly; each tenant's report day/time is checked inside
  await ctx.boss.work(QUEUES.monitorCron, async () => {
    await runJob(log, QUEUES.monitorCron, () =>
      runMonitor({
        system: ctx.system,
        email: ctx.email,
        alertEmail: ctx.env.ALERT_EMAIL,
        now: () => ctx.clock.now(),
      }),
    );
  });
  await ctx.boss.schedule(QUEUES.monitorCron, '*/5 * * * *');
  await ctx.boss.work(QUEUES.maintenanceCron, async () => {
    await runJob(log, QUEUES.maintenanceCron, () => runRetention(ctx));
  });
  await ctx.boss.schedule(QUEUES.maintenanceCron, '30 2 * * *'); // daily, quiet time
  await ctx.boss.work<JobData['assistant-turn']>(
    QUEUES.assistantTurn,
    { localConcurrency: 4 },
    async (jobs) => {
      for (const job of jobs)
        await runJob(log, QUEUES.assistantTurn, () =>
          runAssistantTurn(ctx, job.data.tenantId, job.data.leadId, {
            finalAttempt: job.retryCount >= ASSISTANT_RETRY_LIMIT,
          }),
        );
    },
  );
}
