/**
 * pnpm loadtest [--leads 100] [--seconds 20] [--mix]
 *
 * --mix adds the rest of a real day: 60 customers chatting at once (assistant turn latency, mock
 * assistant: real models add their own latency) and a 09:00-style reminder burst (12 clinics x ~14
 * booked appointments, every 24 h reminder coming due at the same instant).
 *
 * Sends a burst of form leads to a running app (mock WhatsApp) and measures time to the first
 * WhatsApp reply per lead, server-side (first sent message − lead received). Pass: p95 < 60 s.
 * Uses a fresh tenant created as the agency admin (from .env).
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { zonedTimeToUtc } from '@instantlead/core';
import { client, randomPhone, waitFor, type Thread } from './client.ts';

const { values } = parseArgs({
  options: {
    leads: { type: 'string', default: '100' },
    seconds: { type: 'string', default: '20' },
    mix: { type: 'boolean', default: false },
  },
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
let ok = pct(95) < 60;
console.log(ok ? 'PASS first reply (p95 < 60 s)' : 'FAIL first reply (p95 ≥ 60 s)');

if (values.mix) {
  // ---- 60 customers chatting at once ----
  const chatters = ids.slice(0, 60);
  const turn: number[] = [];
  const known = await c.get<{ id: string; phoneE164: string }[]>('/v1/leads');
  const leadPhones = chatters.map((id) => known.find((l) => l.id === id)!.phoneE164);
  console.log('60 customers chatting at once…');
  await Promise.all(
    chatters.map(async (id, i) => {
      for (const text of ['Hi, I want teeth whitening', 'this week please', 'how much is it?']) {
        const before = (await c.get<Thread>(`/v1/leads/${id}/messages`)).messages.filter(
          (m) => m.direction === 'out',
        ).length;
        const sent = Date.now();
        await c.post('/v1/dev/whatsapp/inbound', { from: leadPhones[i], text });
        await waitFor(
          'a reply',
          async () =>
            (await c.get<Thread>(`/v1/leads/${id}/messages`)).messages.filter((m) => m.direction === 'out')
              .length > before,
          60_000,
        );
        turn.push((Date.now() - sent) / 1000);
      }
    }),
  );
  turn.sort((a, b) => a - b);
  const tp = (p: number) => turn[Math.min(turn.length - 1, Math.ceil((p / 100) * turn.length) - 1)]!;
  console.log(
    `assistant turn (message -> reply): p50 ${tp(50).toFixed(2)} s · p95 ${tp(95).toFixed(2)} s · n=${turn.length}`,
  );
  const chatOk = tp(95) < 15;
  console.log(chatOk ? 'PASS chat (p95 < 15 s on the mock assistant)' : 'FAIL chat');
  ok &&= chatOk;

  // ---- reminder burst: everything due at once ----
  console.log('building 12 clinics x ~14 booked appointments…');
  const bookedLeads: { client: ReturnType<typeof client>; id: string }[] = [];
  let lastVisit = new Date(0);
  for (let k = 0; k < 12; k++) {
    const sl = `burst-${randomBytes(3).toString('hex')}`;
    const pw = `load-${randomBytes(9).toString('hex')}`;
    await agency.post('/v1/admin/tenants', {
      slug: sl,
      name: `Burst ${k}`,
      preset: 'clinic_dental',
      admin: { email: `admin@${sl}.test`, name: 'B', password: pw },
    });
    const cc = client(base);
    await cc.signIn(`admin@${sl}.test`, pw);
    const now = new Date((await cc.get<{ now: string }>('/v1/dev/clock')).now);
    // three days ahead, so the 24 h reminders are not due yet
    const day = new Date(now.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
    const { slots } = await cc.get<{ slots: { date: string; time: string }[] }>(
      `/v1/slots?service=Consultation&date=${day}&limit=50`,
    );
    // 30-minute visits + 5-minute buffer on a 15-minute grid: every third slot is bookable back to back.
    const usable = slots.filter((x) => x.date === day).filter((_, i) => i % 3 === 0);
    for (const slot of usable) {
      const { lead_id } = await cc.post<{ lead_id: string }>('/v1/leads', {
        phone: randomPhone(),
        name: 'Burst',
        consent: { granted: true },
      });
      await cc.post('/v1/appointments', {
        lead_id,
        service: 'Consultation',
        date: slot.date,
        time: slot.time,
      });
      bookedLeads.push({ client: cc, id: lead_id });
      const at = zonedTimeToUtc(slot.date, slot.time, 'Asia/Kolkata');
      if (at > lastVisit) lastVisit = at;
    }
  }
  console.log(`${bookedLeads.length} appointments booked; letting their reminders all come due…`);
  const t0 = Date.now();
  const clockNow = new Date((await bookedLeads[0]!.client.get<{ now: string }>('/v1/dev/clock')).now);
  // One hour after the LAST visit's 24 h reminder time: all of them are due, and it is not quiet hours.
  const due = new Date(lastVisit.getTime() - 23 * 3_600_000);
  await bookedLeads[0]!.client.post('/v1/dev/clock/advance', {
    hours: Math.max(1, (due.getTime() - clockNow.getTime()) / 3_600_000),
  }); // past the last 24 h reminder time
  await Promise.all(
    bookedLeads.map(({ client: cc, id }) =>
      waitFor(
        'reminder',
        async () =>
          (await cc.get<Thread>(`/v1/leads/${id}/messages`)).messages.some(
            (m) => m.templateKey === 'reminder_24h' && m.status !== 'queued',
          ),
        120_000,
      ),
    ),
  );
  const burst = (Date.now() - t0) / 1000;
  console.log(
    `reminder burst: ${bookedLeads.length} reminders delivered ${burst.toFixed(1)} s after they came due`,
  );
  const burstOk = burst < 60;
  console.log(burstOk ? 'PASS reminder burst (< 60 s)' : 'FAIL reminder burst');
  ok &&= burstOk;
}
process.exit(ok ? 0 : 1);
