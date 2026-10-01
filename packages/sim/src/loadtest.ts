/**
 * pnpm loadtest [--leads 100] [--seconds 20]
 *
 * Sends a burst of form leads to a running app (mock WhatsApp) and measures time to the first
 * WhatsApp reply per lead, server-side (first sent message − lead received). Pass: p95 < 60 s.
 * Uses a fresh tenant created as the agency admin (from .env).
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { client, randomPhone, waitFor, type Thread } from './client.ts';

const { values } = parseArgs({
  options: { leads: { type: 'string', default: '100' }, seconds: { type: 'string', default: '20' } },
});
const total = Number(values.leads);
const spreadMs = Number(values.seconds) * 1000;
const base = process.env.APP_URL ?? 'http://localhost:3000';

const agency = client(base);
await agency.signIn(process.env.AGENCY_ADMIN_EMAIL ?? '', process.env.AGENCY_ADMIN_PASSWORD ?? '');
const slug = `load-${randomBytes(3).toString('hex')}`;
const password = `load-${randomBytes(9).toString('hex')}`;
await agency.post('/v1/admin/tenants', {
  slug,
  name: 'Load test clinic',
  preset: 'clinic_dental',
  admin: { email: `admin@${slug}.test`, name: 'Load', password },
});
const c = client(base);
await c.signIn(`admin@${slug}.test`, password);

console.log(`sending ${total} leads over ${values.seconds} s…`);
const started = Date.now();
const ids = await Promise.all(
  Array.from({ length: total }, async (_, i) => {
    await sleep((i * spreadMs) / total);
    const r = await c.post<{ lead_id: string }>('/v1/leads', {
      phone: randomPhone(),
      name: `Load ${i}`,
      consent: { granted: true },
    });
    return r.lead_id;
  }),
);
console.log(
  `accepted ${ids.length} leads in ${((Date.now() - started) / 1000).toFixed(1)} s; waiting for replies…`,
);

const latencies: number[] = [];
for (const id of ids) {
  const t = await waitFor(
    `first reply for ${id}`,
    async () => {
      const th = await c.get<Thread>(`/v1/leads/${id}/messages`);
      return (
        th.messages.some((m) => m.direction === 'out' && m.status !== 'queued' && m.status !== 'failed') && th
      );
    },
    120_000,
  );
  const first = t.messages.find((m) => m.direction === 'out')!;
  latencies.push((new Date(first.occurredAt).getTime() - new Date(t.lead.receivedAt).getTime()) / 1000);
}

latencies.sort((a, b) => a - b);
const pct = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]!;
console.log(
  `first reply: p50 ${pct(50).toFixed(2)} s · p95 ${pct(95).toFixed(2)} s · max ${pct(100).toFixed(2)} s`,
);
const ok = pct(95) < 60;
console.log(ok ? 'PASS (p95 < 60 s)' : 'FAIL (p95 ≥ 60 s)');
process.exit(ok ? 0 : 1);
