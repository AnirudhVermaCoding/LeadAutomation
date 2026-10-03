import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Send, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api, type Role, type TenantConfig } from '../api.ts';
import { navigate } from '../router.ts';
import { Badge, Button, Card, cx, Empty, ErrorState, fmt, Loading, PageHeader, Select } from '../ui.tsx';

type Kind = 'LOST_LEAD' | 'EMPTY_SLOT' | 'NO_SHOW' | 'STALLED_TREATMENT' | 'RECALL_DUE' | 'PAYMENT_FOLLOWUP';
interface Opportunity {
  id: string;
  kind: Kind;
  status: 'open' | 'needs_approval' | 'actioned' | 'won' | 'lost' | 'dismissed';
  priority: number;
  reason: string;
  recommendedAction: string;
  detectedAt: string;
  aiActed: boolean;
  actedAt: string | null;
  outcome: string | null;
  valueInr: number | null;
  valueSource: string | null;
  slotStartsAt: string | null;
  leadId: string | null;
  leadName: string | null;
  leadPhone: string | null;
}
interface WaitlistRow {
  id: string;
  leadId: string;
  leadName: string | null;
  leadPhone: string;
  service: string;
  attendeeName: string | null;
  fromDate: string | null;
  toDate: string | null;
  partOfDay: string | null;
  wantsEarlier: boolean;
  source: string;
  joinedAt: string;
}

const KIND: Record<Kind, [string, string]> = {
  EMPTY_SLOT: ['Empty slot', 'bg-sky-50 text-sky-700 ring-sky-200'],
  NO_SHOW: ['No-show', 'bg-orange-50 text-orange-700 ring-orange-200'],
  STALLED_TREATMENT: ['Stalled treatment', 'bg-violet-50 text-violet-700 ring-violet-200'],
  PAYMENT_FOLLOWUP: ['Payment', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  LOST_LEAD: ['Unbooked enquiry', 'bg-amber-50 text-amber-800 ring-amber-200'],
  RECALL_DUE: ['Recall due', 'bg-slate-100 text-slate-700 ring-slate-200'],
};
const STATUS: Record<Opportunity['status'], string> = {
  open: 'open',
  needs_approval: 'needs your approval',
  actioned: 'assistant acted',
  won: 'recovered',
  lost: 'lost',
  dismissed: 'dismissed',
};

/** Revenue recovery: what the deterministic rules found, what the assistant did, and the outcome. */
export function RecoveryPage({ config }: { config: TenantConfig; role: Role }) {
  const [tab, setTab] = useState<'opportunities' | 'waitlist'>('opportunities');
  return (
    <>
      <PageHeader
        title="Recovery"
        subtitle="Freed slots, missed visits, stalled treatments, recalls and balances: found by fixed rules, never guessed."
      />
      <div role="tablist" className="mb-4 flex gap-1 border-b border-slate-200">
        {(
          [
            ['opportunities', 'Opportunities'],
            ['waitlist', 'Waitlist'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === key
                ? 'border-brand-700 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'opportunities' ? (
        <Opportunities tz={config.locale.timezone} />
      ) : (
        <Waitlist tz={config.locale.timezone} />
      )}
    </>
  );
}

function Opportunities({ tz }: { tz: string }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'active' | 'closed'>('active');
  const [kind, setKind] = useState<Kind | ''>('');
  const list = useQuery({
    queryKey: ['opportunities', status, kind],
    queryFn: () => api<Opportunity[]>(`/v1/opportunities?status=${status}${kind ? `&kind=${kind}` : ''}`),
    refetchInterval: 60_000,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'won' | 'lost' | 'dismiss' }) =>
      api(`/v1/opportunities/${id}/${action}`, { method: 'POST', body: {} }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['opportunities'] }),
        qc.invalidateQueries({ queryKey: ['command-center'] }),
      ]),
  });
  return (
    <Card
      title={status === 'active' ? 'Open' : 'Closed'}
      actions={
        <div className="flex gap-2">
          <Select
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind | '')}
            className="w-44"
          >
            <option value="">All kinds</option>
            {(Object.keys(KIND) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND[k][0]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'closed')}
            className="w-28"
          >
            <option value="active">Open</option>
            <option value="closed">Closed</option>
          </Select>
        </div>
      }
    >
      {act.error && (
        <div className="mb-3">
          <ErrorState error={act.error} />
        </div>
      )}
      {list.isPending && <Loading />}
      {list.error && <ErrorState error={list.error} retry={() => void list.refetch()} />}
      {list.data && !list.data.length && (
        <Empty title={status === 'active' ? 'Nothing to recover right now' : 'Nothing closed yet'}>
          The rules run every 15 minutes. Cancellations, no-shows, overdue treatment visits, recalls and
          recorded balances appear here.
        </Empty>
      )}
      <ul className="divide-y divide-slate-100">
        {list.data?.map((o) => (
          <li key={o.id} className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-56 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={KIND[o.kind][1]}>{KIND[o.kind][0]}</Badge>
                <Badge
                  tone={
                    o.status === 'needs_approval' ? 'bg-amber-50 text-amber-800 ring-amber-200' : undefined
                  }
                >
                  {STATUS[o.status]}
                </Badge>
                {o.leadId ? (
                  <button
                    className="text-sm font-medium text-slate-900 hover:underline"
                    onClick={() => navigate(`/inbox?lead=${o.leadId}`)}
                  >
                    {o.leadName ?? o.leadPhone}
                  </button>
                ) : (
                  o.slotStartsAt && (
                    <span className="text-sm font-medium text-slate-900">
                      {fmt.dateTime(o.slotStartsAt, tz)}
                    </span>
                  )
                )}
                {o.valueInr !== null && (
                  <span className="text-xs text-slate-600" title="Entered by your team on the treatment plan">
                    {fmt.inr(o.valueInr)} {o.kind === 'PAYMENT_FOLLOWUP' ? 'pending' : 'plan value'}
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-700">{o.reason}</p>
              <p className="text-xs text-slate-500">
                {o.outcome ?? o.recommendedAction} · found {fmt.ago(o.detectedAt)}
                {o.aiActed && o.actedAt ? ` · assistant acted ${fmt.ago(o.actedAt)}` : ''}
              </p>
            </div>
            {status === 'active' && (
              <div className="flex flex-wrap gap-1.5">
                {(o.status === 'needs_approval' || (o.status === 'open' && o.actedAt && !o.aiActed)) &&
                  o.kind !== 'NO_SHOW' && (
                    <Button
                      size="sm"
                      loading={act.isPending}
                      onClick={() => act.mutate({ id: o.id, action: 'approve' })}
                    >
                      <Send className="size-3.5" aria-hidden />{' '}
                      {o.status === 'needs_approval' ? 'Approve & send' : 'Try again'}
                    </Button>
                  )}
                {o.leadId && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => act.mutate({ id: o.id, action: 'won' })}
                  >
                    <Check className="size-3.5" aria-hidden /> Recovered
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Mark lost"
                  onClick={() => act.mutate({ id: o.id, action: 'lost' })}
                >
                  <X className="size-3.5" aria-hidden /> Lost
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: o.id, action: 'dismiss' })}>
                  Dismiss
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Waitlist({ tz }: { tz: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['waitlist'],
    queryFn: () => api<WaitlistRow[]>('/v1/waitlist'),
    refetchInterval: 60_000,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/waitlist/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['waitlist'] }),
  });
  return (
    <Card title="Waiting for an earlier or different time">
      {list.isPending && <Loading />}
      {list.error && <ErrorState error={list.error} retry={() => void list.refetch()} />}
      {remove.error && <ErrorState error={remove.error} />}
      {list.data && !list.data.length && (
        <Empty title="Nobody is waiting">
          Patients join when none of the offered times suit them. When a booking is cancelled, the freed time
          is offered to them on WhatsApp, and the first to accept gets it.
        </Empty>
      )}
      <ul className="divide-y divide-slate-100">
        {list.data?.map((w, i) => (
          <li key={w.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="w-6 text-xs tabular-nums text-slate-400">{i + 1}</span>
            <button className="min-w-48 flex-1 text-left" onClick={() => navigate(`/inbox?lead=${w.leadId}`)}>
              <p className="text-sm font-medium text-slate-900">
                {w.leadName ?? w.leadPhone}
                {w.attendeeName ? ` · for ${w.attendeeName}` : ''}
              </p>
              <p className="text-xs text-slate-500">
                {w.service}
                {w.wantsEarlier ? ' · wants an earlier time' : ''}
                {w.fromDate || w.toDate ? ` · ${w.fromDate ?? 'any'} to ${w.toDate ?? 'any'}` : ''}
                {w.partOfDay ? ` · ${w.partOfDay}` : ''} · joined {fmt.dateTime(w.joinedAt, tz)}
              </p>
            </button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Remove from waitlist"
              onClick={() => remove.mutate(w.id)}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
