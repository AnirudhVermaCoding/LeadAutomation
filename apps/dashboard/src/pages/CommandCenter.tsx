import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.ts';
import { navigate } from '../router.ts';
import { Badge, Card, cx, ErrorState, fmt } from '../ui.tsx';

export interface CommandCenterData {
  date: string;
  today: {
    enquiries: number;
    bookings: number;
    confirmations: number;
    attended: number;
    cancellations: number;
    noShows: number;
    recovered: number;
    followUps: number;
    escalations: number;
    unresolved: number;
    calls: number;
  };
  attention: {
    staff: { lead_id: string; name: string | null; phone: string; reason: string | null; since: string }[];
    urgent: { lead_id: string; name: string | null; phone: string; at: string }[];
    unconfirmed: {
      id: string;
      lead_id: string;
      name: string | null;
      phone: string;
      service: string;
      starts_at: string;
      status: string;
    }[];
    opportunities: {
      id: string;
      kind: 'STALLED_TREATMENT' | 'EMPTY_SLOT' | 'PAYMENT_FOLLOWUP';
      status: string;
      reason: string;
      lead_id: string | null;
      name: string | null;
      phone: string | null;
      slot_starts_at: string | null;
      value_inr: string | null;
    }[];
    needsApproval: number;
  };
  impact: {
    days: number;
    conversations: number;
    calls: number;
    appointmentsBooked: number;
    slotsRecovered: number;
    noShowsRecovered: number;
    treatmentsReactivated: number;
    patientsReactivated: number;
    escalations: number;
    knownValueInr: number | null;
  };
  voiceEnabled: boolean;
}

const KIND_LABEL = {
  STALLED_TREATMENT: 'Stalled treatment',
  EMPTY_SLOT: 'Empty slot',
  PAYMENT_FOLLOWUP: 'Payment follow-up',
} as const;

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'good' }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-xs">
      <p
        className={cx(
          'text-lg font-semibold tabular-nums',
          tone === 'warn' && value > 0
            ? 'text-amber-700'
            : tone === 'good' && value > 0
              ? 'text-emerald-700'
              : 'text-slate-900',
        )}
      >
        {value}
      </p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  );
}

const openLead = (id: string | null) => id && navigate(`/inbox?lead=${id}`);

/** Today's numbers, what needs a person now, and what the assistant achieved (Today page, owner view). */
export function CommandCenter({ tz }: { tz: string }) {
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: ['command-center'],
    queryFn: () => api<CommandCenterData>('/v1/command-center'),
    refetchInterval: 60_000,
  });
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (!q.data)
    return (
      <div
        className="mb-5 grid animate-pulse grid-cols-2 gap-2 sm:grid-cols-5"
        aria-busy="true"
        aria-label="Loading today's numbers"
      >
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="h-14 rounded-lg bg-slate-100" />
        ))}
      </div>
    );
  const { today: d, attention: a, impact: i } = q.data;
  // An urgent escalation is listed once, at the top, not again under "needs staff".
  const urgentIds = new Set(a.urgent.map((u) => u.lead_id));
  const staff = a.staff.filter((s) => !urgentIds.has(s.lead_id));
  const attentionCount = staff.length + a.unconfirmed.length + a.opportunities.length + a.urgent.length;

  return (
    <div className="mb-6 space-y-4">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        <Stat label="Enquiries" value={d.enquiries} />
        <Stat label="Bookings" value={d.bookings} />
        <Stat label="Confirmations" value={d.confirmations} />
        <Stat label="Attended" value={d.attended} />
        <Stat label="Cancellations" value={d.cancellations} tone="warn" />
        <Stat label="No-shows" value={d.noShows} tone="warn" />
        <Stat label="Recovered" value={d.recovered} tone="good" />
        <Stat label="Follow-ups sent" value={d.followUps} />
        <Stat label="Escalations" value={d.escalations} tone="warn" />
        <Stat label="Unresolved" value={d.unresolved} tone="warn" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          className="min-w-0 lg:col-span-2"
          title={`Needs attention${attentionCount ? ` (${attentionCount})` : ''}`}
          actions={
            a.needsApproval > 0 ? (
              <button
                className="text-xs font-medium text-brand-700 hover:underline"
                onClick={() => navigate('/recovery')}
              >
                {a.needsApproval} waiting for your approval{' '}
                <ArrowRight className="inline size-3" aria-hidden />
              </button>
            ) : undefined
          }
        >
          {attentionCount === 0 ? (
            <p className="text-sm text-slate-500">Nothing needs a person right now.</p>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 text-sm">
                {[
                  ...a.urgent.map((u) => (
                    <li key={`u${u.lead_id}`} className="flex items-center gap-2 py-2">
                      <AlertTriangle className="size-4 shrink-0 text-red-600" aria-hidden />
                      <button
                        className="min-w-0 flex-1 truncate text-left font-medium text-red-800"
                        onClick={() => openLead(u.lead_id)}
                      >
                        Urgent: {u.name ?? u.phone}
                      </button>
                      <span className="text-xs text-slate-500">{fmt.ago(u.at)}</span>
                    </li>
                  )),
                  ...staff.map((s) => (
                    <li key={`s${s.lead_id}`} className="flex items-center gap-2 py-2">
                      <Badge tone="bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200">needs staff</Badge>
                      <button
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => openLead(s.lead_id)}
                      >
                        <span className="font-medium text-slate-900">{s.name ?? s.phone}</span>
                        {s.reason && <span className="text-slate-500"> · {s.reason}</span>}
                      </button>
                      <span className="text-xs text-slate-500">{fmt.ago(s.since)}</span>
                    </li>
                  )),
                  ...a.unconfirmed.map((u) => (
                    <li key={`c${u.id}`} className="flex items-center gap-2 py-2">
                      <Badge tone="bg-amber-50 text-amber-800 ring-amber-200">
                        {u.status === 'pending' ? 'to confirm' : 'unconfirmed'}
                      </Badge>
                      <button
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => openLead(u.lead_id)}
                      >
                        <span className="font-medium text-slate-900">{u.name ?? u.phone}</span>
                        <span className="text-slate-500">
                          {' '}
                          · {u.service}, {fmt.dateTime(u.starts_at, tz)}
                        </span>
                      </button>
                    </li>
                  )),
                  ...a.opportunities.map((o) => (
                    <li key={`o${o.id}`} className="flex items-center gap-2 py-2">
                      <Badge tone="bg-sky-50 text-sky-700 ring-sky-200">{KIND_LABEL[o.kind]}</Badge>
                      <button
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => (o.lead_id ? openLead(o.lead_id) : navigate('/recovery'))}
                      >
                        <span className="font-medium text-slate-900">
                          {o.kind === 'EMPTY_SLOT' && o.slot_starts_at
                            ? fmt.dateTime(o.slot_starts_at, tz)
                            : (o.name ?? o.phone ?? 'Patient')}
                        </span>
                        <span className="text-slate-500"> · {o.reason}</span>
                      </button>
                    </li>
                  )),
                ].slice(0, showAll ? undefined : 10)}
              </ul>
              {attentionCount > 10 && (
                <button
                  className="mt-2 text-xs font-medium text-brand-700 hover:underline"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? 'Show fewer' : `Show all ${attentionCount}`}
                </button>
              )}
            </>
          )}
        </Card>

        <Card
          title={
            <span className="flex items-center gap-1.5">
              <Sparkles className="size-4 text-brand-700" aria-hidden /> AI impact, last {i.days} days
            </span>
          }
        >
          <dl className="space-y-1.5 text-sm">
            {(
              [
                ['Conversations handled', i.conversations],
                ...(q.data.voiceEnabled ? ([['Phone calls answered', i.calls]] as const) : []),
                ['Appointments booked', i.appointmentsBooked],
                ['Freed slots refilled', i.slotsRecovered],
                ['No-shows rebooked', i.noShowsRecovered],
                ['Treatments restarted', i.treatmentsReactivated],
                ['Patients reactivated', i.patientsReactivated],
                ['Handed to staff', i.escalations],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-slate-600">{label}</dt>
                <dd className="font-semibold tabular-nums text-slate-900">{value}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 border-t border-slate-100 pt-1.5">
              <dt className="text-slate-600">Known recovered value</dt>
              <dd className="text-right font-semibold tabular-nums text-slate-900">
                {i.knownValueInr === null ? (
                  <span className="text-xs font-normal text-slate-500">not available</span>
                ) : (
                  fmt.inr(i.knownValueInr)
                )}
              </dd>
            </div>
            <p className="text-xs text-slate-500">
              Value counts only amounts your team entered on treatment plans. Nothing is estimated.
            </p>
          </dl>
        </Card>
      </div>
    </div>
  );
}
