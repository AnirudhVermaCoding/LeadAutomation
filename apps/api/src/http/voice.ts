import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../audit.ts';
import { getActiveConfig } from '../config-store.ts';
import { withTenant } from '../db/client.ts';
import { availabilityRules } from '../db/schema.ts';
import { getTenantSecret, setTenantSecret } from '../secrets.ts';
import type { AppContext } from '../system/context.ts';
import { handleVoiceEvent, VOICE_SECRET, voiceAssistantSetup, voiceTenant } from '../voice.ts';
import { guard, type Principal } from './auth.ts';

const actor = (p: Principal | null) =>
  p?.kind === 'user' ? ({ type: 'user', id: p.userId } as const) : ({ type: 'system' } as const);

export function registerVoiceRoutes(app: FastifyInstance, ctx: AppContext) {
  const admins = guard(ctx, ['client_admin', 'agency_admin'], { tenant: true });
  const tenantOf = (req: FastifyRequest) => req.tenantId as string;
  const webhookUrl = (key: string | null | undefined) =>
    key ? `${ctx.env.APP_URL}/webhooks/voice/${key}` : null;

  // The phone agent vendor (Vapi) posts every server message here. The secret path segment finds the
  // clinic; the vendor credential (bearer secret) proves it is them. Off for the clinic = 404, as if absent.
  // Not per-IP rate limited (index.ts): every clinic's calls arrive from the vendor's few IPs.
  app.post<{ Params: { key: string } }>('/webhooks/voice/:key', async (req, reply) => {
    const tenantId = await ctx.system.findTenantIdBy('voiceInKey', req.params.key);
    if (!tenantId) return reply.code(404).send({ error: 'not_found' });
    const t = await voiceTenant(ctx, tenantId);
    if ('error' in t)
      return t.error === 'disabled'
        ? reply.code(404).send({ error: 'not_found' })
        : reply.code(503).send({ error: 'voice_not_configured' });
    if (!t.provider.authenticate(req.headers, t.secret))
      return reply.code(401).send({ error: 'unauthorized' });
    return handleVoiceEvent(ctx, tenantId, t, t.provider.parse(req.body));
  });

  // Settings → Phone agent: what to paste into the vendor console.
  app.get('/v1/voice/setup', { preHandler: admins }, async (req) => {
    const tenantId = tenantOf(req);
    const routing = await ctx.system.getTenantRouting(tenantId);
    return withTenant(ctx.db, tenantId, async (tx) => {
      const config = (await getActiveConfig(tx))?.config;
      if (!config) throw new Error('tenant has no config');
      const resources = [
        ...new Set(
          (await tx.select({ r: availabilityRules.resource }).from(availabilityRules)).map((x) => x.r),
        ),
      ];
      const hasSecret = Boolean(await getTenantSecret(tx, ctx.secretsKey, tenantId, VOICE_SECRET));
      return {
        enabled: Boolean(config.voice?.enabled),
        webhook_url: webhookUrl(routing?.voiceInKey),
        has_secret: hasSecret,
        ...voiceAssistantSetup(config, webhookUrl(routing?.voiceInKey), resources),
      };
    });
  });

  // New webhook address + credential (shown once). The old ones stop working immediately.
  app.post('/v1/voice/rotate', { preHandler: admins }, async (req) => {
    const tenantId = tenantOf(req);
    const key = randomBytes(24).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    await ctx.system.setTenantRouting(tenantId, { voiceInKey: key });
    await withTenant(ctx.db, tenantId, async (tx) => {
      await setTenantSecret(tx, ctx.secretsKey, tenantId, VOICE_SECRET, secret);
      await audit(tx, ctx.clock, actor(req.principal), {
        action: 'integration.voice.rotated',
        entityType: 'integration',
        entityId: 'voice',
      });
    });
    return { webhook_url: webhookUrl(key), secret };
  });
}
