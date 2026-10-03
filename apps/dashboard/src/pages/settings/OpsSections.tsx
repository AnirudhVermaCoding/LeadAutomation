import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, type TenantConfig } from '../../api.ts';
import { Button, Card, ErrorState, Field, Input, Loading, Select, Textarea } from '../../ui.tsx';
import type { Edit } from '../Settings.tsx';

type Props = { draft: TenantConfig; edit: Edit };
type Mode = 'auto' | 'approval' | 'off';
type Action = NonNullable<keyof NonNullable<TenantConfig['autonomy']>>;

// Mirrors AUTONOMY_DEFAULTS / JOURNEY_DEFAULTS / NEVER_ACTIONS in packages/config (the server enforces them).
const ACTIONS: [Action, string, string][] = [
  ['faq', 'Answer questions from your Knowledge', 'Off or approval: questions go to your team instead'],
  ['book', 'Book appointments', 'Approval: bookings wait for your team to confirm'],
  ['reschedule', 'Reschedule appointments', 'Approval: your team handles each request'],
  ['cancel', 'Cancel appointments', 'Approval: your team handles each request'],
  ['remind', 'Send appointment reminders', ''],
  ['follow_up', 'Follow up stalled treatments', 'Uses your approved treatment_followup template'],
  ['waitlist_offer', 'Offer freed slots to the waitlist', ''],
  [
    'reactivate',
    'Reactivate unbooked enquiries and recalls',
    'Marketing templates; WhatsApp opt-outs are respected',
  ],
  ['payment_reminder', 'Send payment reminders', 'Only amounts your team recorded, with your payment link'],
];
const DEFAULTS: Record<Action, Mode> = {
  faq: 'auto',
  book: 'auto',
  reschedule: 'auto',
  cancel: 'auto',
  remind: 'auto',
  follow_up: 'auto',
  waitlist_offer: 'auto',
  reactivate: 'auto',
  payment_reminder: 'auto',
};
const JOURNEY_DEFAULTS = {
  stall_grace_days: 7,
  recall_months: 6,
  lost_lead_after_hours: 48,
  max_outreach_per_day: 30,
  waitlist_offer_minutes: 30,
  waitlist_batch: 3,
};
const NEVER = [
  'Diagnose a condition',
  'Prescribe or name medicines or doses',
  'Change or recommend clinical treatment',
  'Interpret symptoms, reports or photos',
  'State medical facts or prices that are not in your information',
  'Override clinic policy',
  'Make emergency decisions (emergencies go to your team immediately)',
];

export function AutonomySection({ draft, edit }: Props) {
  const j = { ...JOURNEY_DEFAULTS, ...draft.journeys };
  const setJ = (k: keyof typeof JOURNEY_DEFAULTS, v: number) =>
    edit((d) => {
      d.journeys = { ...JOURNEY_DEFAULTS, ...d.journeys, [k]: v };
    });
  return (
    <>
      <Card title="What the assistant may do">
        <p className="mb-3 text-sm text-slate-600">
          <strong>Automatic</strong>: it acts by itself. <strong>Needs approval</strong>: it hands the request
          to your team (bookings wait for confirmation; follow-ups wait under Recovery). <strong>Off</strong>:
          it never does it.
        </p>
        <div className="divide-y divide-slate-100">
          {ACTIONS.map(([key, label, hint]) => (
            <div key={key} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-slate-800">{label}</p>
                {hint && <p className="text-xs text-slate-500">{hint}</p>}
              </div>
              <Select
                aria-label={label}
                className="w-44"
                value={draft.autonomy?.[key] ?? DEFAULTS[key]}
                onChange={(e) =>
                  edit((d) => {
                    d.autonomy = { ...d.autonomy, [key]: e.target.value as Mode };
                  })
                }
              >
                <option value="auto">Automatic</option>
                <option value="approval">Needs approval</option>
                <option value="off">Off</option>
              </Select>
            </div>
          ))}
        </div>
      </Card>
      <Card
        title={
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="size-4 text-emerald-700" aria-hidden /> Always handed to your team, never
            done by the assistant
          </span>
        }
      >
        <ul className="grid gap-1 text-sm text-slate-700 sm:grid-cols-2">
          {NEVER.map((n) => (
            <li key={n}>· {n}</li>
          ))}
          <li>· Refunds, discounts or special prices, complaints, billing disputes</li>
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          These are fixed in the software and cannot be switched on.
        </p>
      </Card>
      <Card title="Treatment follow-up, recall and recovery">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Treatment counts as stalled after (days overdue)">
            <Input
              type="number"
              min={1}
              max={90}
              value={j.stall_grace_days}
              onChange={(e) => setJ('stall_grace_days', Number(e.target.value))}
            />
          </Field>
          <Field label="Recall after (months)">
            <Input
              type="number"
              min={1}
              max={36}
              value={j.recall_months}
              onChange={(e) => setJ('recall_months', Number(e.target.value))}
            />
          </Field>
          <Field label="Unbooked enquiry after (hours quiet)">
            <Input
              type="number"
              min={12}
              max={720}
              value={j.lost_lead_after_hours}
              onChange={(e) => setJ('lost_lead_after_hours', Number(e.target.value))}
            />
          </Field>
          <Field label="Max assistant follow-ups per day" hint="0 = none">
            <Input
              type="number"
              min={0}
              max={500}
              value={j.max_outreach_per_day}
              onChange={(e) => setJ('max_outreach_per_day', Number(e.target.value))}
            />
          </Field>
          <Field label="Waitlist offer is open for (minutes)">
            <Input
              type="number"
              min={5}
              max={1440}
              value={j.waitlist_offer_minutes}
              onChange={(e) => setJ('waitlist_offer_minutes', Number(e.target.value))}
            />
          </Field>
          <Field label="Offer each freed slot to (people at a time)">
            <Input
              type="number"
              min={1}
              max={10}
              value={j.waitlist_batch}
              onChange={(e) => setJ('waitlist_batch', Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field
            label="Payment link (your UPI / gateway page)"
            hint="Payment reminders are sent only when this is set and your team recorded the amount."
          >
            <Input
              type="url"
              placeholder="https://"
              value={j.payment_url ?? ''}
              onChange={(e) =>
                edit((d) => {
                  const next = { ...JOURNEY_DEFAULTS, ...d.journeys };
                  if (e.target.value) next.payment_url = e.target.value;
                  else delete next.payment_url;
                  d.journeys = next;
                })
              }
            />
          </Field>
        </div>
      </Card>
    </>
  );
}

const VOICE_DEFAULT: NonNullable<TenantConfig['voice']> = {
  enabled: false,
  provider: 'vapi',
  call_disclosure:
    'Hello, you have reached {{business_name}}. I am the virtual assistant and can help with appointments.',
  monthly_minutes_cap: 1000,
};

interface VoiceSetup {
  enabled: boolean;
  webhook_url: string | null;
  has_secret: boolean;
  systemPrompt: string;
  tools: unknown[];
}

export function PhoneAgentSection({ draft, edit, canEdit }: Props & { canEdit: boolean }) {
  const v = draft.voice ?? VOICE_DEFAULT;
  const setV = (patch: Partial<NonNullable<TenantConfig['voice']>>) =>
    edit((d) => {
      d.voice = { ...VOICE_DEFAULT, ...d.voice, ...patch };
    });
  return (
    <>
      <Card title="AI phone receptionist (optional)">
        <p className="mb-3 text-sm text-slate-600">
          Answers calls (after hours, or when the front desk is busy), books, reschedules and cancels through
          the same rules as WhatsApp, answers questions from your Knowledge, and transfers to your team. It
          never makes outgoing promotional calls.
        </p>
        <label className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-800">
          <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ enabled: e.target.checked })} />{' '}
          Phone agent is on
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Transfer calls to (your clinic number)"
            hint="International format. Without it, the agent takes a message."
          >
            <Input
              value={v.transfer_number ?? ''}
              placeholder="+919876543210"
              onChange={(e) =>
                edit((d) => {
                  const next = { ...VOICE_DEFAULT, ...d.voice };
                  if (e.target.value) next.transfer_number = e.target.value;
                  else delete next.transfer_number;
                  d.voice = next;
                })
              }
            />
          </Field>
          <Field label="Monthly minutes limit" hint="Above it, calls go straight to your team. 0 = no limit.">
            <Input
              type="number"
              min={0}
              value={v.monthly_minutes_cap}
              onChange={(e) => setV({ monthly_minutes_cap: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field
            label="Said at the start of every call"
            hint="Tell callers they are speaking with an assistant. {{business_name}} is filled in."
          >
            <Textarea
              rows={2}
              value={v.call_disclosure}
              onChange={(e) => setV({ call_disclosure: e.target.value })}
            />
          </Field>
        </div>
      </Card>
      <VoiceSetupCard canEdit={canEdit} />
    </>
  );
}

function VoiceSetupCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const setup = useQuery({
    queryKey: ['voice-setup'],
    queryFn: () => api<VoiceSetup>('/v1/voice/setup'),
    enabled: canEdit,
  });
  const rotate = useMutation({
    mutationFn: () => api<{ webhook_url: string; secret: string }>('/v1/voice/rotate', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['voice-setup'] }),
  });
  const [copied, setCopied] = useState('');
  const copy = (label: string, text: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    });
  if (!canEdit) return null;
  return (
    <Card title="Connect the phone provider (Vapi)">
      {setup.isPending && <Loading />}
      {setup.error && <ErrorState error={setup.error} retry={() => void setup.refetch()} />}
      {setup.data && (
        <div className="space-y-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-slate-600">
            <li>Create the webhook address and credential below (save the settings above first).</li>
            <li>
              In Vapi, add a Bearer-token credential with that secret, and set the assistant's server URL to
              the address.
            </li>
            <li>
              Paste the system prompt and the tools; connect your Indian number (via your telecom provider's
              SIP trunk).
            </li>
            <li>Call the number yourself before going live.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1 text-xs">
              {setup.data.webhook_url ?? 'No webhook address yet'}
            </code>
            {setup.data.webhook_url && (
              <Button size="sm" variant="ghost" onClick={() => copy('url', setup.data.webhook_url!)}>
                <Copy className="size-3.5" aria-hidden /> {copied === 'url' ? 'Copied' : 'Copy'}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              loading={rotate.isPending}
              onClick={() =>
                (!setup.data.webhook_url ||
                  confirm('Create a new address and secret? The current ones stop working immediately.')) &&
                rotate.mutate()
              }
            >
              <KeyRound className="size-3.5" aria-hidden /> {setup.data.webhook_url ? 'Rotate' : 'Create'}
            </Button>
          </div>
          {rotate.data && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900" role="status">
              Secret (shown once, copy it into Vapi now):{' '}
              <code className="break-all">{rotate.data.secret}</code>
            </div>
          )}
          {rotate.error && <ErrorState error={rotate.error} />}
          {!setup.data.enabled && (
            <p className="text-xs text-slate-500">
              The phone agent is off: calls to the webhook are refused until you turn it on.
            </p>
          )}
          <Field label="System prompt for the voice assistant">
            <Textarea readOnly rows={8} value={setup.data.systemPrompt} className="font-mono text-xs" />
          </Field>
          <div className="flex justify-between">
            <Button size="sm" variant="ghost" onClick={() => copy('prompt', setup.data.systemPrompt)}>
              <Copy className="size-3.5" aria-hidden /> {copied === 'prompt' ? 'Copied' : 'Copy prompt'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => copy('tools', JSON.stringify(setup.data.tools, null, 2))}
            >
              <Copy className="size-3.5" aria-hidden />{' '}
              {copied === 'tools' ? 'Copied' : `Copy ${setup.data.tools.length} tools (JSON)`}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
