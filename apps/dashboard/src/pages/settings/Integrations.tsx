import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, Copy, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api.ts';
import { GoogleCard } from './GoogleCard.tsx';
import { Badge, Button, Card, ErrorState, Field, fmt, Input, Loading } from '../../ui.tsx';

interface Status {
  whatsapp: { connected: boolean; phone_number_id: string | null; waba_id: string | null };
  lead_ads: { connected: boolean; page_id: string | null };
  channel: 'meta' | 'fake' | 'none';
  form_url: string | null;
}

const Dot = ({ ok, label }: { ok: boolean; label: string }) => (
  <span className="inline-flex items-center gap-1.5 text-sm">
    {ok ? (
      <CheckCircle2 className="size-4 text-brand-600" aria-hidden />
    ) : (
      <CircleDashed className="size-4 text-slate-400" aria-hidden />
    )}
    {label}
  </span>
);

export function Integrations({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['integrations'], queryFn: () => api<Status>('/v1/integrations') });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['integrations'] }),
      qc.invalidateQueries({ queryKey: ['onboarding'] }),
    ]);
  const test = useMutation({
    mutationFn: (kind: 'whatsapp' | 'email') =>
      api<{ ok: boolean; message: string }>('/v1/integrations/test', { body: { kind } }),
  });

  if (status.isPending) return <Loading />;
  if (status.error) return <ErrorState error={status.error} />;
  const s = status.data;

  return (
    <>
      <Card title="Status">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Dot
            ok={s.whatsapp.connected}
            label={s.whatsapp.connected ? 'WhatsApp connected' : 'WhatsApp not connected'}
          />
          <Dot
            ok={s.lead_ads.connected}
            label={s.lead_ads.connected ? 'Lead Ads connected' : 'Lead Ads not connected'}
          />
          <Badge tone={s.channel === 'fake' ? 'bg-amber-50 text-amber-800 ring-amber-200' : undefined}>
            {s.channel === 'fake'
              ? 'Mock mode: messages are simulated'
              : s.channel === 'meta'
                ? 'Live WhatsApp'
                : 'No channel'}
          </Badge>
        </div>
        {canEdit && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={test.isPending && test.variables === 'whatsapp'}
              onClick={() => test.mutate('whatsapp')}
            >
              Test WhatsApp
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={test.isPending && test.variables === 'email'}
              onClick={() => test.mutate('email')}
            >
              Send test email
            </Button>
          </div>
        )}
        {test.data && (
          <p className={`mt-3 text-sm ${test.data.ok ? 'text-brand-700' : 'text-red-700'}`} role="status">
            {test.data.message}
          </p>
        )}
      </Card>

      <Health />

      {canEdit && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Connect
            title="WhatsApp (Meta Cloud API)"
            idLabel="Phone number ID"
            tokenLabel="Permanent access token"
            current={s.whatsapp.phone_number_id}
            extra={{
              label: 'WhatsApp Business Account ID',
              hint: 'Optional. Lets InstantLead read each template approval status from Meta automatically.',
              current: s.whatsapp.waba_id,
            }}
            path="/v1/integrations/whatsapp"
            onDone={refresh}
          />
          <Connect
            title="Facebook / Instagram Lead Ads"
            idLabel="Facebook Page ID"
            tokenLabel="Page access token"
            current={s.lead_ads.page_id}
            path="/v1/integrations/lead-ads"
            onDone={refresh}
          />
        </div>
      )}

      <GoogleCard canEdit={canEdit} />

      {s.form_url && <FormEmbed url={s.form_url} />}
      {canEdit && <ApiKeys />}
      {canEdit && <Webhooks />}
      {canEdit && <DataExport />}
    </>
  );
}

function Connect({
  title,
  idLabel,
  tokenLabel,
  current,
  extra,
  path,
  onDone,
}: {
  title: string;
  idLabel: string;
  tokenLabel: string;
  current: string | null;
  /** A second optional id sent as `waba_id` (WhatsApp only). */
  extra?: { label: string; hint: string; current: string | null };
  path: string;
  onDone: () => unknown;
}) {
  const [id, setId] = useState(current ?? '');
  const [extraId, setExtraId] = useState(extra?.current ?? '');
  const [token, setToken] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(path, {
        method: 'PUT',
        body: { id, access_token: token, ...(extraId.trim() ? { waba_id: extraId.trim() } : {}) },
      }),
    onSuccess: () => {
      setToken('');
      return onDone();
    },
  });
  return (
    <Card title={title}>
      <div className="space-y-3">
        <Field label={idLabel}>
          <Input value={id} onChange={(e) => setId(e.target.value)} inputMode="numeric" />
        </Field>
        {extra && (
          <Field label={extra.label} hint={extra.hint}>
            <Input value={extraId} onChange={(e) => setExtraId(e.target.value)} inputMode="numeric" />
          </Field>
        )}
        <Field label={tokenLabel} hint="Stored encrypted. It is never shown again.">
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </Field>
        {save.error && <p className="text-sm text-red-700">{save.error.message}</p>}
        {save.isSuccess && <p className="text-sm text-brand-700">Saved.</p>}
        <Button
          size="sm"
          disabled={!id || token.length < 20}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {current ? 'Update' : 'Connect'}
        </Button>
      </div>
    </Card>
  );
}

function FormEmbed({ url }: { url: string }) {
  const snippet = `<iframe src="${url}" style="width:100%;max-width:440px;height:520px;border:0" title="Enquiry form"></iframe>`;
  const [copied, setCopied] = useState(false);
  return (
    <Card title="Website form">
      <p className="mb-2 text-sm text-slate-600">
        Hosted form:{' '}
        <a className="text-brand-700 underline" href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
        . Paste this on the clinic website:
      </p>
      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{snippet}</pre>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2"
        onClick={() => void navigator.clipboard.writeText(snippet).then(() => setCopied(true))}
      >
        <Copy className="size-3.5" aria-hidden /> {copied ? 'Copied' : 'Copy snippet'}
      </Button>
    </Card>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () =>
      api<
        { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null }[]
      >('/v1/api-keys'),
  });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ key: string }>('/v1/api-keys', { body: { name } }),
    onSuccess: () => {
      setName('');
      return qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
  return (
    <Card
      title="API keys"
      actions={
        <span className="text-xs text-slate-500">For POST /v1/leads from the clinic's website or CRM</span>
      }
    >
      {create.data && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">Copy this key now — it won't be shown again:</p>
          <code className="mt-1 block break-all font-mono text-xs">{create.data.key}</code>
        </div>
      )}
      <ul className="mb-3 divide-y divide-slate-100 text-sm">
        {keys.data?.map((k) => (
          <li key={k.id} className="flex items-center justify-between gap-2 py-2">
            <span className="flex items-center gap-2">
              <KeyRound className="size-4 text-slate-400" aria-hidden />
              {k.name} <code className="text-xs text-slate-500">{k.prefix}…</code>
              {k.revokedAt ? (
                <Badge>revoked</Badge>
              ) : (
                <span className="text-xs text-slate-400">
                  {k.lastUsedAt ? `used ${fmt.ago(k.lastUsedAt)}` : 'never used'}
                </span>
              )}
            </span>
            {!k.revokedAt && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => confirm(`Revoke "${k.name}"?`) && revoke.mutate(k.id)}
              >
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-end gap-2">
        <Field label="New key name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Website form" />
        </Field>
        <Button size="sm" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
          Create key
        </Button>
      </div>
    </Card>
  );
}

const WEBHOOK_EVENTS = [
  'lead.created',
  'lead.qualified',
  'appointment.booked',
  'appointment.completed',
  'lead.opted_out',
] as const;

/** Outbound webhooks: push events to the clinic's CRM / Zapier / Make, HMAC-signed. */
function Webhooks() {
  const qc = useQueryClient();
  const hooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () =>
      api<
        {
          id: string;
          url: string;
          events: string[];
          lastStatus: number | null;
          lastError: string | null;
          lastDeliveredAt: string | null;
        }[]
      >('/v1/webhooks'),
  });
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([...WEBHOOK_EVENTS]);
  const create = useMutation({
    mutationFn: () => api<{ secret: string }>('/v1/webhooks', { body: { url, events } }),
    onSuccess: () => {
      setUrl('');
      return qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  return (
    <Card
      title="Webhooks"
      actions={<span className="text-xs text-slate-500">Signed with x-instantlead-signature (see docs)</span>}
    >
      {create.data && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">Signing secret — copy it now, it won't be shown again:</p>
          <code className="mt-1 block break-all font-mono text-xs">{create.data.secret}</code>
        </div>
      )}
      <ul className="mb-3 divide-y divide-slate-100 text-sm">
        {hooks.data?.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0">
              <code className="break-all text-xs">{h.url}</code>
              <span className="block text-xs text-slate-500">
                {h.events.join(', ')} ·{' '}
                {h.lastError ? (
                  <span className="text-red-700">{h.lastError}</span>
                ) : h.lastDeliveredAt ? (
                  `delivered ${fmt.ago(h.lastDeliveredAt)}`
                ) : (
                  'nothing sent yet'
                )}
              </span>
            </span>
            <Button
              size="sm"
              variant="danger"
              onClick={() => confirm('Delete this webhook?') && remove.mutate(h.id)}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <fieldset className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <legend className="sr-only">Events</legend>
        {WEBHOOK_EVENTS.map((e) => (
          <label key={e} className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={events.includes(e)}
              onChange={(ev) => setEvents(ev.target.checked ? [...events, e] : events.filter((x) => x !== e))}
            />
            {e}
          </label>
        ))}
      </fieldset>
      <div className="flex items-end gap-2">
        <Field label="Endpoint URL">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.zapier.com/…"
          />
        </Field>
        <Button
          size="sm"
          disabled={!url.trim() || !events.length}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          Add webhook
        </Button>
      </div>
      {create.error && <p className="mt-2 text-sm text-red-700">{create.error.message}</p>}
    </Card>
  );
}

/** DPDP data portability: everything this clinic's account holds, as one JSON file. */
function DataExport() {
  return (
    <Card title="Your data">
      <p className="mb-3 text-sm text-slate-600">
        Download every lead, message, consent and appointment as JSON. To erase one person, open their
        conversation and use “Erase lead”.
      </p>
      <a
        href="/v1/export"
        className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        Download export
      </a>
    </Card>
  );
}

interface HealthData {
  lastSuccessfulSend: string | null;
  lastDeliveryReceipt: string | null;
  lastInboundMessage: string | null;
  failedSends24h: number;
  llmErrors24h: number;
  lastAssistantReply: string | null;
}

/** What actually happened recently: the quickest way to see if something is broken. */
function Health() {
  const q = useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthData>('/v1/health'),
    refetchInterval: 30_000,
  });
  if (!q.data) return null;
  const h = q.data;
  const when = (iso: string | null) => (iso ? fmt.ago(iso) : 'never');
  const rows: [string, string, boolean][] = [
    ['Last message sent', when(h.lastSuccessfulSend), true],
    ['Last delivery receipt (webhook)', when(h.lastDeliveryReceipt), true],
    ['Last message received', when(h.lastInboundMessage), true],
    ['Last AI reply', when(h.lastAssistantReply), true],
    ['Failed sends (24 h)', String(h.failedSends24h), h.failedSends24h === 0],
    ['AI errors (24 h)', String(h.llmErrors24h), h.llmErrors24h === 0],
  ];
  return (
    <Card title="Health">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([label, value, ok]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-slate-500">{label}</dt>
            <dd className={ok ? 'font-medium text-slate-800' : 'font-semibold text-red-700'}>{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
