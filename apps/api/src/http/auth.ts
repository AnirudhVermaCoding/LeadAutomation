import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { USER_ROLES, type UserRole } from '../db/schema.ts';
import type { AppContext } from '../system/context.ts';

export type Principal =
  | { kind: 'user'; userId: string; role: UserRole; tenantId: string | null }
  | { kind: 'api_key'; apiKeyId: string; tenantId: string };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    /** Tenant this request acts on; set by `guard` for tenant routes. */
    tenantId: string | null;
  }
}

/** Mounts Better Auth at /api/auth/* (per its official Fastify integration). */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(req, reply) {
      const res = await ctx.auth.handler(
        new Request(new URL(req.url, ctx.env.APP_URL), {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
        }),
      );
      reply.status(res.status);
      res.headers.forEach((value, name) => {
        if (name !== 'set-cookie') void reply.header(name, value);
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) void reply.header('set-cookie', cookies);
      return reply.send(res.body ? await res.text() : null);
    },
  });
}

async function resolvePrincipal(req: FastifyRequest, ctx: AppContext): Promise<Principal | null> {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith('Bearer il_')) {
    const key = await ctx.system.resolveApiKey(authorization.slice('Bearer '.length));
    return key && { kind: 'api_key', ...key };
  }
  const session = await ctx.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session || session.user.banned) return null;
  const role = session.user.role;
  if (!USER_ROLES.includes(role as UserRole)) return null;
  return {
    kind: 'user',
    userId: session.user.id,
    role: role as UserRole,
    tenantId: (session.user.tenantId as string | null | undefined) ?? null,
  };
}

type Allowed = UserRole | 'api_key';
const roleOf = (p: Principal): Allowed => (p.kind === 'api_key' ? 'api_key' : p.role);

/**
 * preHandler: authenticate, check role, and (for tenant routes) pick the tenant.
 * Client users and API keys are pinned to their own tenant; only the agency admin
 * may choose one, via the `x-tenant-id` header (the dashboard's tenant switcher).
 */
export function guard(ctx: AppContext, allowed: Allowed[], opts: { tenant: boolean }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolvePrincipal(req, ctx);
    req.principal = principal;
    if (!principal) return reply.code(401).send({ error: 'unauthenticated' });
    if (!allowed.includes(roleOf(principal))) return reply.code(403).send({ error: 'forbidden' });
    if (!opts.tenant) return;

    const header = req.headers['x-tenant-id'];
    const chosen =
      principal.kind === 'user' && principal.role === 'agency_admin' ? header : principal.tenantId;
    if (typeof chosen !== 'string' || !chosen)
      return reply
        .code(400)
        .send({ error: 'tenant_required', message: 'Select a tenant (x-tenant-id header)' });
    req.tenantId = chosen;
  };
}

export function decorateRequests(app: FastifyInstance) {
  app.decorateRequest('principal', null);
  app.decorateRequest('tenantId', null);
}
