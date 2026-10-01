import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FastForward, FileText, MessageCircle, RotateCcw, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, type LeadDetail, type Role, type TenantConfig } from '../api.ts';
import { navigate } from '../router.ts';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  fmt,
  Input,
  PageHeader,
  StateBadge,
  TierBadge,
} from '../ui.tsx';
import { Thread } from './Thread.tsx';

const randomPhone = () => `90000${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;

/**
 * Show a prospect the whole flow live with the tenant's real config and the mock WhatsApp
 * channel: form or WhatsApp lead -> AI qualification -> booking -> reminders (fast-forward).
 */
export function Sandbox({ config }: { config: TenantConfig; role: Role }) {
  const qc = useQueryClient();
  const tz = config.locale.timezone;
  const [name, setName] = useState('Priya Sharma');
  const [phone, setPhone] = useState(randomPhone);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [text, setText] = useState('');

  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api<{ channel: string }>('/v1/integrations'),
  });
  const clock = useQuery({
    queryKey: ['clock'],
    queryFn: () => api<{ now: string; canAdvance: boolean }>('/v1/dev/clock'),
  });
  const detail = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => api<LeadDetail>(`/v1/leads/${leadId}`),
    enabled: Boolean(leadId),
    refetchInterval: 1_000,
  });

  const start = useMutation({
    mutationFn: async (via: 'form' | 'whatsapp') => {
      if (via === 'form')
        return (
          await api<{ lead_id: string }>('/v1/leads', { body: { phone, name, consent: { granted: true } } })
        ).lead_id;
      const r = await api<{ leadId?: string }>('/v1/dev/whatsapp/inbound', {
        body: { from: phone, profile_name: name, text: text.trim() || 'Hi! I saw your ad on Instagram.' },
      });
      setText('');
      return r.leadId ?? null;
    },
    onSuccess: (id) => setLeadId(id),
  });
  const say = useMutation({
    mutationFn: (body: { text?: string; button_payload?: string }) =>
      api('/v1/dev/whatsapp/inbound', { body: { from: phone, ...body } }),
    onSuccess: () => setText(''),
    onSettled: () => qc.invalidateQueries({ queryKey: ['lead', leadId] }),
  });
  const advance = useMutation({
    mutationFn: (hours: number) =>
      api<{ now: string; steps_queued: number }>('/v1/dev/clock/advance', { body: { hours } }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['clock'] }),
        qc.invalidateQueries({ queryKey: ['lead', leadId] }),
      ]),
  });

  const reset = () => {
    setLeadId(null);
    setPhone(randomPhone());
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    if (leadId) say.mutate({ text });
    else start.mutate('whatsapp');
  };

  if (integrations.data && integrations.data.channel !== 'fake')
    return (
      <>
        <PageHeader title="Demo sandbox" />
        <ErrorState
          error={
            new Error(
              'This tenant is connected to real WhatsApp, so the sandbox is off (it would message real numbers). Use a demo tenant.',
            )
          }
        />
      </>
    );

  const lead = detail.data?.lead;
  return (
    <>
      <PageHeader
        title="Demo sandbox"
        subtitle="Play the customer. Everything runs on this tenant's real settings with a simulated WhatsApp."
        actions={
          leadId && (
            <Button variant="secondary" size="sm" onClick={reset}>
              <RotateCcw className="size-3.5" aria-hidden /> New customer
            </Button>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card title={leadId ? `WhatsApp · ${config.brand.business_name}` : 'Start as a new customer'}>
          {!leadId && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Field label="Customer name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Phone (fake)">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
              </Field>
              <Button
                className="sm:col-span-2"
                loading={start.isPending && start.variables === 'form'}
                onClick={() => start.mutate('form')}
              >
                <FileText className="size-4" aria-hidden /> Submit the website form
              </Button>
              <p className="text-center text-xs text-slate-500 sm:col-span-2">
                …or type a first WhatsApp message below (like a click-to-WhatsApp ad).
              </p>
            </div>
          )}
          {start.error && <ErrorState error={start.error} />}
          {leadId && (
            <Thread
              messages={detail.data?.messages ?? []}
              tz={tz}
              onButton={(payload, title) => say.mutate({ button_payload: payload, text: title })}
              className="h-[26rem] max-h-none"
            />
          )}
          <form onSubmit={submit} className="mt-3 flex gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type as the customer…"
              aria-label="Customer message"
            />
            <Button
              type="submit"
              loading={say.isPending || (start.isPending && start.variables === 'whatsapp')}
              aria-label="Send"
            >
              {leadId ? (
                <Send className="size-4" aria-hidden />
              ) : (
                <MessageCircle className="size-4" aria-hidden />
              )}
            </Button>
          </form>
          {say.error && <p className="mt-2 text-xs text-red-700">{say.error.message}</p>}
        </Card>

        <div className="space-y-4">
          <Card title="What the clinic sees">
            {!lead ? (
              <p className="text-sm text-slate-500">
                Start a conversation to see the lead appear, get qualified and booked.
              </p>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StateBadge state={lead.state} aiPaused={lead.aiPaused} />
                  <TierBadge tier={lead.tier} />
                  {lead.score !== null && <Badge>score {lead.score}</Badge>}
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/inbox?lead=${lead.id}`)}>
                    Open in inbox
                  </Button>
                </div>
                {detail.data!.answers.length > 0 && (
                  <ul className="space-y-0.5 text-xs">
                    {detail.data!.answers.map((a) => (
                      <li key={a.key}>
                        <span className="text-slate-500">{a.key.replaceAll('_', ' ')}:</span>{' '}
                        <span className="font-medium">{a.value.replaceAll('_', ' ')}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {detail.data!.appointment && (
                  <p className="rounded-lg bg-brand-50 p-2 text-xs text-brand-800">
                    {detail.data!.appointment.service} · {fmt.dateTime(detail.data!.appointment.startsAt, tz)}{' '}
                    · {detail.data!.appointment.status}
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title="Fast-forward time">
            {clock.data && (
              <p className="mb-3 text-sm text-slate-600">
                Clinic time:{' '}
                <span className="font-medium text-slate-900">{fmt.dateTime(clock.data.now, tz)}</span>
              </p>
            )}
            {clock.data?.canAdvance ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {[
                    [1, '+1 hour'],
                    [22, '+22 hours'],
                    [48, '+2 days'],
                    [72, '+3 days'],
                  ].map(([h, label]) => (
                    <Button
                      key={h}
                      size="sm"
                      variant="secondary"
                      loading={advance.isPending && advance.variables === h}
                      onClick={() => advance.mutate(h as number)}
                    >
                      <FastForward className="size-3.5" aria-hidden /> {label}
                    </Button>
                  ))}
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Shows follow-ups to silent leads (day 2, day 5), reminders before appointments (24 h, 2 h)
                  and review requests. Quiet hours ({config.locale.quiet_hours.start}–
                  {config.locale.quiet_hours.end}) still apply. The clock is shared by the whole demo server.
                </p>
                {advance.data && (
                  <p className="mt-2 text-xs text-brand-700">
                    {advance.data.steps_queued} scheduled message(s) became due.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-slate-500">Only available in mock mode.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
