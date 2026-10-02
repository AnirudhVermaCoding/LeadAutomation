/**
 * pnpm demo — the four acceptance scenarios against a running app in mock mode
 * (pnpm dev, or docker compose up). Creates fresh tenants as the agency admin (from .env),
 * fast-forwards the business clock through /v1/dev/clock/advance, and checks each outcome.
 * Exit code 1 on any failure.
 */
import { randomBytes } from 'node:crypto';
import { addDays, HOUR, localParts, zonedTimeToUtc } from '@instantlead/core';
import { client, randomPhone, waitFor, type Client, type Thread } from './client.ts';

const base = process.env.APP_URL ?? 'http://localhost:3000';
const TZ = 'Asia/Kolkata'; // the clinic preset's timezone
const run = randomBytes(3).toString('hex');

const step = (s: string) => console.log(`  · ${s}`);
function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`  ✓ ${what}`);
}

async function newClinic(
  agency: Client,
  label: string,
  preset: 'clinic_dental' | 'real_estate' = 'clinic_dental',
) {
  const slug = `demo-${label}-${run}`;
  const password = `demo-${randomBytes(9).toString('hex')}`;
  const email = `admin@${slug}.test`;
  await agency.post('/v1/admin/tenants', {
    slug,
    name: preset === 'real_estate' ? `Skyline Realty (${label})` : `Smile Dental (${label})`,
    preset,
    admin: { email, name: 'Clinic Admin', password },
  });
  const c = client(base);
  await c.signIn(email, password);
  return c;
}

const now = async (c: Client) => new Date((await c.get<{ now: string }>('/v1/dev/clock')).now);
async function advanceHours(c: Client, hours: number) {
  for (let left = hours; left > 0; left -= 720)
    await c.post('/v1/dev/clock/advance', { hours: Math.min(left, 720) });
}
/** Fast-forward to the next `weekday` (e.g. 'mon') at `time` local, strictly in the future. */
async function advanceTo(c: Client, weekday: string, time: string) {
  const current = await now(c);
  for (let d = 0; d <= 7; d++) {
    const date = addDays(localParts(current, TZ).date, d);
    const at = zonedTimeToUtc(date, time, TZ);
    if (at > current && localParts(at, TZ).weekday === weekday) {
      await advanceHours(c, (at.getTime() - current.getTime()) / HOUR);
      return at;
    }
  }
  throw new Error(`no ${weekday} ahead`);
}

const thread = (c: Client, leadId: string) => c.get<Thread>(`/v1/leads/${leadId}/messages`);
const outKeys = (t: Thread) =>
  t.messages.filter((m) => m.direction === 'out').map((m) => m.templateKey ?? 'text');
const waitForOut = (c: Client, leadId: string, what: string, pred: (keys: string[], t: Thread) => boolean) =>
  waitFor(what, async () => {
    const t = await thread(c, leadId);
    return pred(outKeys(t), t) && t;
  });

async function newLead(c: Client, name = 'Priya Sharma') {
  const phone = randomPhone();
  const sentAt = Date.now();
  const { lead_id } = await c.post<{ lead_id: string }>('/v1/leads', {
    phone,
    name,
    consent: { granted: true },
  });
  const t = await waitForOut(c, lead_id, 'the first WhatsApp reply', (k) => k.includes('first_reply'));
  return { leadId: lead_id, phone, firstReplyMs: Date.now() - sentAt, thread: t };
}

async function say(c: Client, leadId: string, phone: string, text: string) {
  const before = outKeys(await thread(c, leadId)).length;
  await c.post('/v1/dev/whatsapp/inbound', { from: phone, text });
  const t = await waitForOut(c, leadId, `a reply to "${text}"`, (k) => k.length > before);
  const reply = t.messages.filter((m) => m.direction === 'out').at(-1)!.body;
  console.log(`      lead > ${text}\n      bot  < ${reply}`);
  return t;
}

interface Appointment {
  id: string;
  leadId: string;
  startsAt: string;
  status: string;
}
async function appointmentOf(c: Client, leadId: string) {
  const from = new Date((await now(c)).getTime() - 30 * 24 * HOUR).toISOString();
  const to = new Date((await now(c)).getTime() + 60 * 24 * HOUR).toISOString();
  const list = await c.get<Appointment[]>(`/v1/appointments?from=${from}&to=${to}`);
  const mine = list.filter((a) => a.leadId === leadId);
  return mine.find((a) => a.status !== 'cancelled') ?? mine[0];
}
async function staffBook(c: Client, leadId: string, date: string, after = '12:00') {
  const { slots } = await c.get<{ slots: { date: string; time: string }[] }>(
    `/v1/slots?service=Consultation&date=${date}&limit=20`,
  );
  const slot = slots.find((s) => s.date === date && s.time >= after);
  if (!slot) throw new Error(`no free slot on ${date}`);
  const { appointment } = await c.post<{ appointment: Appointment }>('/v1/appointments', {
    lead_id: leadId,
    service: 'Consultation',
    date: slot.date,
    time: slot.time,
  });
  return appointment;
}

// ---------------------------------------------------------------------------------------

async function happyPath(agency: Client) {
  const c = await newClinic(agency, 'happy');
  await advanceTo(c, 'mon', '10:00');
  step('a website form lead arrives');
  const { leadId, phone, firstReplyMs } = await newLead(c);
  check(firstReplyMs < 60_000, `first WhatsApp reply in ${(firstReplyMs / 1000).toFixed(1)} s (< 60 s)`);

  step('the AI qualifies and books');
  await say(c, leadId, phone, 'Hi, I need teeth whitening');
  await say(c, leadId, phone, 'this week please');
  const t = await say(c, leadId, phone, '3');
  check(
    ['booked', 'confirmed'].includes(t.lead.state) && t.lead.tier !== null,
    `lead is ${t.lead.state}/${t.lead.tier}`,
  );
  let appt = (await appointmentOf(c, leadId))!;
  if (appt.status === 'pending') {
    step('front desk confirms the requested slot');
    await c.post(`/v1/appointments/${appt.id}/confirm`);
    appt = (await appointmentOf(c, leadId))!;
  }
  check(
    Boolean(appt),
    `appointment at ${localParts(new Date(appt.startsAt), TZ).date} ${localParts(new Date(appt.startsAt), TZ).time}`,
  );

  const startsAt = new Date(appt.startsAt).getTime();
  const untilReminder = (hoursBefore: number) => async () =>
    (startsAt - hoursBefore * HOUR - (await now(c)).getTime()) / HOUR;
  for (const [hoursBefore, key] of [
    [24, 'reminder_24h'],
    [2, 'reminder_2h'],
  ] as const) {
    const h = await untilReminder(hoursBefore)();
    if (h <= 0) {
      step(`${key} not applicable (booked less than ${hoursBefore} h ahead)`);
      continue;
    }
    await advanceHours(c, h + 0.05);
    await waitForOut(c, leadId, key, (k) => k.includes(key));
    check(true, `${key} sent`);
  }
  await advanceHours(c, (startsAt - (await now(c)).getTime()) / HOUR + 1);
  step('the visit happens; staff tap "Completed"');
  await c.post(`/v1/appointments/${appt.id}/complete`);
  await advanceHours(c, 3);
  await waitForOut(c, leadId, 'review request', (k) => k.includes('review_request'));
  check(true, 'review request sent after the visit');
}

async function silentLead(agency: Client) {
  const c = await newClinic(agency, 'silent');
  await advanceTo(c, 'tue', '11:00');
  const { leadId } = await newLead(c, 'Rahul Verma');
  check(true, 'day 0: first reply');
  await advanceHours(c, 48);
  await waitForOut(c, leadId, 'day-2 follow-up', (k) => k.includes('followup_day2'));
  check(true, 'day 2: follow-up sent');
  await advanceHours(c, 72);
  await waitForOut(c, leadId, 'day-5 follow-up', (k) => k.includes('followup_day5'));
  check(true, 'day 5: last follow-up sent');
  await advanceHours(c, 48);
  const t = await waitFor('unresponsive', async () => {
    const th = await thread(c, leadId);
    return th.lead.state === 'unresponsive' && th;
  });
  check(outKeys(t).length === 3, `marked unresponsive after ${outKeys(t).join(' → ')}`);
}

async function noShow(agency: Client) {
  const c = await newClinic(agency, 'noshow');
  await advanceTo(c, 'wed', '10:00');
  const { leadId } = await newLead(c, 'Anita Rao');
  const appt = await staffBook(c, leadId, localParts(await now(c), TZ).date);
  check(true, `booked for today ${localParts(new Date(appt.startsAt), TZ).time}`);
  await advanceHours(c, (new Date(appt.startsAt).getTime() - (await now(c)).getTime()) / HOUR + 0.5);
  step('patient does not turn up; staff tap "No-show"');
  await c.post(`/v1/appointments/${appt.id}/no-show`);
  await advanceHours(c, 2);
  const t = await waitForOut(c, leadId, 'no-show recovery', (k) => k.includes('no_show_recovery'));
  check(t.lead.state === 'no_show', 'recovery message sent, offering to rebook');
}

interface Report {
  periodStart: string;
  sentAt: string | null;
  data: Record<string, unknown> & { period: { label: string } };
}
async function weeklyReport(agency: Client) {
  const c = await newClinic(agency, 'report');
  const monday = await advanceTo(c, 'mon', '10:00');
  step('a week of activity: 3 leads, 1 reply, 2 bookings, 1 visit, 1 no-show');
  const leads = [await newLead(c, 'Lead One'), await newLead(c, 'Lead Two'), await newLead(c, 'Lead Three')];
  await say(c, leads[0]!.leadId, leads[0]!.phone, 'How much is whitening?');
  const tuesday = addDays(localParts(monday, TZ).date, 1);
  const a = await staffBook(c, leads[0]!.leadId, tuesday, '11:00');
  const b = await staffBook(c, leads[1]!.leadId, tuesday, '15:00');
  await advanceTo(c, 'tue', '18:00');
  await c.post(`/v1/appointments/${a.id}/complete`);
  await c.post(`/v1/appointments/${b.id}/no-show`);

  step('Monday 09:05: the weekly report goes out');
  await advanceTo(c, 'mon', '09:05');
  const reports = await waitFor('the weekly report', async () => {
    const r = await c.get<Report[]>('/v1/reports');
    return r.length > 0 && r;
  });
  const d = reports[0]!.data;
  const expected = {
    leads: 3,
    repliedLeads: 1,
    booked: 2,
    shows: 1,
    noShows: 1,
    showRate: 0.5,
    revenueRecoveredInr: 4000,
  };
  for (const [k, v] of Object.entries(expected)) check(d[k] === v, `${k} = ${String(d[k])} (expected ${v})`);
  check(reports[0]!.sentAt !== null, `report for ${d.period.label} emailed to the owner`);
}

async function realEstateAgentAway(agency: Client) {
  const c = await newClinic(agency, 'realty', 'real_estate');
  await advanceTo(c, 'tue', '10:00');
  step('a property enquiry from a website form');
  const { leadId, phone, firstReplyMs } = await newLead(c, 'Rohit Mehra');
  check(firstReplyMs < 60_000, `first WhatsApp reply in ${(firstReplyMs / 1000).toFixed(1)} s (< 60 s)`);
  for (const text of ['Hi, looking for a 3BHK', 'budget around 1 crore', 'Baner or Aundh', 'immediately'])
    await say(c, leadId, phone, text);
  const t = await say(c, leadId, phone, '1');
  check(['booked', 'confirmed'].includes(t.lead.state), `site visit booked (${t.lead.state}/${t.lead.tier})`);
  const first = (await appointmentOf(c, leadId))!;
  check(first.status === 'scheduled', 'confirmed instantly (real estate auto-confirms)');

  step('the agent is called away that day; the office blocks the time');
  const start = new Date(first.startsAt).getTime();
  const block = await c.post<{ id: string; affected: { id: string }[] }>('/v1/blocked-times', {
    starts_at: new Date(start - HOUR).toISOString(),
    ends_at: new Date(start + 2 * HOUR).toISOString(),
    reason: 'Agent at another site',
  });
  check(block.affected.length === 1, '1 booking affected; nothing sent until the office decides');
  await c.post(`/v1/blocked-times/${block.id}/notify`);
  await waitForOut(c, leadId, 'the change notice', (k) => k.includes('appointment_change'));
  check(true, 'customer told, with a [Show new times] button');

  const before = outKeys(await thread(c, leadId)).length;
  await c.post('/v1/dev/whatsapp/inbound', {
    from: phone,
    button_payload: 'appointment_change:times',
    text: 'Show new times',
  });
  const offer = await waitForOut(c, leadId, 'new times', (k) => k.length > before);
  console.log(`      bot  < ${offer.messages.filter((m) => m.direction === 'out').at(-1)!.body}`);
  await say(c, leadId, phone, '1');
  const second = (await waitFor('the new booking', async () => {
    const a = await appointmentOf(c, leadId);
    return a && a.id !== first.id && a.status !== 'cancelled' && a;
  }))!;
  check(
    new Date(second.startsAt).getTime() !== start,
    `rebooked for ${localParts(new Date(second.startsAt), TZ).date} ${localParts(new Date(second.startsAt), TZ).time}`,
  );
}

const SCENARIOS = { happyPath, silentLead, noShow, weeklyReport, realEstateAgentAway };

const agency = client(base);
const email = process.env.AGENCY_ADMIN_EMAIL;
const password = process.env.AGENCY_ADMIN_PASSWORD;
if (!email || !password) throw new Error('set AGENCY_ADMIN_EMAIL / AGENCY_ADMIN_PASSWORD (see .env.example)');
await agency.signIn(email, password).catch((err: unknown) => {
  throw new Error(`${String(err)} — is the app running (pnpm dev) and seeded (pnpm db:seed)?`);
});

const only = process.argv[2];
let failed = 0;
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  console.log(`\n== ${name}`);
  try {
    await scenario(agency);
    console.log(`  PASS`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(failed ? `\n${failed} scenario(s) failed` : '\nAll scenarios passed');
process.exit(failed ? 1 : 0);
