/**
 * pnpm sim --tenant demo-clinic --persona eager_patient   (or --persona all)
 *
 * Plays a lead against a running API (pnpm dev) through the mock WhatsApp endpoint,
 * prints the conversation and checks the persona's expectations. Exit code 1 on failure.
 * Signs in as admin@<tenant>.test with SEED_PASSWORD (see .env.example / pnpm db:seed).
 */
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { PERSONAS, type Outcome } from './personas.ts';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string', default: 'demo-clinic' },
    persona: { type: 'string', default: 'all' },
    base: { type: 'string', default: process.env.APP_URL ?? 'http://localhost:3000' },
    password: { type: 'string', default: process.env.SEED_PASSWORD ?? 'dev-demo-password' },
  },
});
const base = values.base;

async function signIn(): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: `admin@${values.tenant}.test`, password: values.password }),
  });
  if (!res.ok) throw new Error(`sign-in failed (${res.status}); did you run pnpm db:seed?`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function api<T>(cookie: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Thread {
  lead: Outcome['lead'];
  messages: { direction: 'in' | 'out'; body: string }[];
}

async function run(cookie: string, name: string): Promise<boolean> {
  const persona = PERSONAS[name];
  if (!persona) throw new Error(`unknown persona ${name}; try: ${Object.keys(PERSONAS).join(', ')}`);
  const from = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  console.log(`\n== ${name}: ${persona.description} (${from})`);

  let leadId = '';
  let thread: Thread = { lead: { state: 'new', tier: null, aiPaused: false, language: null }, messages: [] };
  for (const text of persona.messages) {
    const before = thread.messages.filter((m) => m.direction === 'out').length;
    const res = await api<{ leadId?: string }>(cookie, '/v1/dev/whatsapp/inbound', { from, text });
    leadId ||= res.leadId ?? '';
    console.log(`  lead > ${text}`);
    // Wait for the assistant (3 s debounce + model time), unless it won't answer anymore.
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      thread = await api<Thread>(cookie, `/v1/leads/${leadId}/messages`);
      const outs = thread.messages.filter((m) => m.direction === 'out');
      if (outs.length > before || thread.lead.state === 'opted_out' || (thread.lead.aiPaused && i > 8)) {
        for (const m of outs.slice(before)) console.log(`  bot  < ${m.body}`);
        break;
      }
    }
  }
  const failure = persona.check({
    lead: thread.lead,
    replies: thread.messages.filter((m) => m.direction === 'out').map((m) => m.body),
  });
  console.log(
    failure
      ? `  FAIL: ${failure}`
      : `  PASS (state ${thread.lead.state}${thread.lead.tier ? `/${thread.lead.tier}` : ''})`,
  );
  return !failure;
}

const cookie = await signIn();
const names = values.persona === 'all' ? Object.keys(PERSONAS) : [values.persona];
let ok = true;
for (const name of names) ok = (await run(cookie, name)) && ok;
process.exit(ok ? 0 : 1);
