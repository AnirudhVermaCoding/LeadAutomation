import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Hand, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, type InboxRow, type LeadDetail, type Role, type TenantConfig } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  ErrorState,
  fmt,
  Loading,
  PageHeader,
  StateBadge,
  Textarea,
  TierBadge,
} from '../ui.tsx';
import { Thread } from './Thread.tsx';

const FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'hot', label: 'Hot', test: (l: InboxRow) => l.tier === 'hot' },
  {
    key: 'takeover',
    label: 'Needs a person',
    test: (l: InboxRow) => l.aiPaused && l.state !== 'opted_out' && !l.notALead,
  },
  { key: 'booked', label: 'Booked', test: (l: InboxRow) => ['booked', 'confirmed'].includes(l.state) },
  {
    key: 'open',
    label: 'In progress',
    test: (l: InboxRow) => ['contacted', 'qualifying', 'qualified', 'booking_offered'].includes(l.state),
  },
  { key: 'junk', label: 'Not a lead', test: (l: InboxRow) => l.notALead !== null },
] as const;

export function InboxPage({ config, role }: { config: TenantConfig; role: Role }) {
  const { search } = useLocation();
  const selected = new URLSearchParams(search).get('lead');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const list = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<InboxRow[]>('/v1/inbox'),
    refetchInterval: 5_000,
  });
  const rows = (list.data ?? []).filter(FILTERS.find((f) => f.key === filter)!.test);

  return (
    <>
      <PageHeader title="Inbox" subtitle="Every lead and every WhatsApp conversation" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className={cx(selected && 'hidden lg:block')}>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cx(
                  'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset',
                  filter === f.key
                    ? 'bg-brand-700 text-white ring-brand-700'
                    : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Card className="overflow-hidden">
            {list.isPending && <Loading />}
            {list.error && <ErrorState error={list.error} retry={() => void list.refetch()} />}
            {list.data && !rows.length && (
              <Empty title="No leads here">Leads from forms, ads and WhatsApp appear instantly.</Empty>
            )}
            <ul className="-m-4 divide-y divide-slate-100">
              {rows.map((l) => (
                <li key={l.id}>
                  <button
                    onClick={() => navigate(`/inbox?lead=${l.id}`)}
                    className={cx(
                      'w-full px-4 py-3 text-left hover:bg-slate-50',
                      selected === l.id && 'bg-brand-50/60',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-slate-900">{l.name ?? l.phone}</span>
                      <span className="shrink-0 text-xs text-slate-400">
                        {fmt.ago(l.lastInboundAt ?? l.receivedAt)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <StateBadge state={l.state} aiPaused={l.aiPaused} />
                      <TierBadge tier={l.tier} />
                      <span className="text-xs text-slate-400">{l.source.replaceAll('_', ' ')}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className={cx(!selected && 'hidden lg:block')}>
          {selected ? (
            <Conversation leadId={selected} config={config} canErase={role !== 'client_staff'} />
          ) : (
            <Card>
              <Empty title="Pick a lead to see the conversation" />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Conversation({
  leadId,
  config,
  canErase,
}: {
  leadId: string;
  config: TenantConfig;
  canErase: boolean;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => api<LeadDetail>(`/v1/leads/${leadId}`),
    refetchInterval: 4_000,
  });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['lead', leadId] }),
      qc.invalidateQueries({ queryKey: ['inbox'] }),
    ]);
  const toggle = useMutation({
    mutationFn: (to: 'takeover' | 'resume') => api(`/v1/leads/${leadId}/${to}`, { method: 'POST' }),
    onSettled: refresh,
  });
  // DPDP erasure request: removes the lead and their messages for good (opt-outs stay suppressed).
  const erase = useMutation({
    mutationFn: () => api(`/v1/leads/${leadId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['inbox'] });
      navigate('/inbox');
    },
  });
  const realLead = useMutation({
    mutationFn: () => api(`/v1/leads/${leadId}/real-lead`, { method: 'POST' }),
    onSettled: refresh,
  });
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => api(`/v1/leads/${leadId}/messages`, { body: { text } }),
    onSuccess: () => setText(''),
    onSettled: refresh,
  });

  if (detail.isPending)
    return (
      <Card>
        <Loading />
      </Card>
    );
  if (detail.error) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  const { lead, answers, appointment, messages, conversation } = detail.data;
  const windowOpen = conversation?.windowExpiresAt
    ? new Date(conversation.windowExpiresAt) > new Date()
    : false;
  const tz = config.locale.timezone;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) send.mutate();
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <button className="lg:hidden" onClick={() => navigate('/inbox')} aria-label="Back to list">
            <ArrowLeft className="size-4" />
          </button>
          {lead.name ?? lead.phoneE164}
        </span>
      }
      actions={
        lead.notALead ? (
          <Button
            size="sm"
            variant="secondary"
            loading={realLead.isPending}
            onClick={() => realLead.mutate()}
          >
            Mark as real lead
          </Button>
        ) : (
          lead.state !== 'opted_out' &&
          (lead.aiPaused ? (
            <Button
              size="sm"
              variant="secondary"
              loading={toggle.isPending}
              onClick={() => toggle.mutate('resume')}
            >
              <Bot className="size-3.5" aria-hidden /> Hand back to AI
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={toggle.isPending}
              onClick={() => toggle.mutate('takeover')}
            >
              <Hand className="size-3.5" aria-hidden /> Take over
            </Button>
          ))
        )
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <StateBadge state={lead.state} aiPaused={lead.aiPaused} />
        {lead.notALead && <Badge>not a lead: {lead.notALead.replaceAll('_', ' ')}</Badge>}
        <TierBadge tier={lead.tier} />
        {lead.score !== null && <Badge>score {lead.score}</Badge>}
        <span>{lead.phoneE164}</span>
        {lead.email && <span>· {lead.email}</span>}
        <span>· {lead.source.replaceAll('_', ' ')}</span>
        {lead.language && <span>· {lead.language}</span>}
      </div>
      {(answers.length > 0 || appointment) && (
        <dl className="mb-4 grid gap-x-6 gap-y-1 rounded-lg bg-slate-50 p-3 text-xs sm:grid-cols-2">
          {answers.map((a) => (
            <div key={a.key} className="flex gap-2">
              <dt className="text-slate-500">{a.key.replaceAll('_', ' ')}</dt>
              <dd className="font-medium text-slate-800">{a.value.replaceAll('_', ' ')}</dd>
            </div>
          ))}
          {appointment && (
            <div className="flex gap-2 sm:col-span-2">
              <dt className="text-slate-500">appointment</dt>
              <dd className="font-medium text-slate-800">
                {appointment.service}, {fmt.dateTime(appointment.startsAt, tz)} ({appointment.status})
              </dd>
            </div>
          )}
        </dl>
      )}
      <Thread messages={messages} tz={tz} />
      <form onSubmit={submit} className="mt-4 space-y-2 border-t border-slate-100 pt-4">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            windowOpen
              ? 'Reply as staff…'
              : 'The 24-hour WhatsApp window is closed: only approved templates can be sent.'
          }
          disabled={!windowOpen || lead.state === 'opted_out'}
          rows={2}
        />
        {send.error && <p className="text-xs text-red-700">{send.error.message}</p>}
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            {lead.aiPaused
              ? 'AI is paused for this lead.'
              : 'Sending a reply does not pause the AI. Use "Take over" for that.'}
            {canErase && (
              <button
                type="button"
                className="ml-2 text-red-700 underline-offset-2 hover:underline"
                onClick={() =>
                  confirm(
                    'Erase this person and all their messages permanently? Use this for a data deletion request.',
                  ) && erase.mutate()
                }
              >
                Erase lead
              </button>
            )}
          </p>
          <Button type="submit" size="sm" loading={send.isPending} disabled={!windowOpen || !text.trim()}>
            <Send className="size-3.5" aria-hidden /> Send
          </Button>
        </div>
      </form>
    </Card>
  );
}
