import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Role, type TenantConfig } from '../api.ts';
import { Button, Card, cx, Empty, ErrorState, fmt, Loading, PageHeader } from '../ui.tsx';

interface ReportData {
  period: { start: string; end: string; label: string };
  leads: number;
  medianFirstResponseSec: number | null;
  repliedLeads: number;
  replyRate: number | null;
  qualified: number;
  booked: number;
  shows: number;
  noShows: number;
  showRate: number | null;
  revenueRecoveredInr: number;
  upcomingBookings: number;
  topTopics: { topic: string; count: number }[];
  costs: { whatsappInr: number; llmUsd: number };
}
interface StoredReport {
  id: string;
  periodStart: string;
  data: ReportData;
  sentAt: string | null;
  sentTo: string[] | null;
  error: string | null;
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const secs = (s: number | null) => (s === null ? '—' : s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);

export function ReportsPage({ config }: { config: TenantConfig; role: Role }) {
  const preview = useQuery({
    queryKey: ['report-preview'],
    queryFn: () => api<{ data: ReportData; email: { subject: string; text: string } }>('/v1/reports/preview'),
    refetchInterval: 30_000,
  });
  const history = useQuery({ queryKey: ['reports'], queryFn: () => api<StoredReport[]>('/v1/reports') });
  const [showEmail, setShowEmail] = useState(false);

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`The owner gets this every ${config.reports.weekly_day[0]!.toUpperCase()}${config.reports.weekly_day.slice(1)} at 9 am`}
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowEmail((v) => !v)}
            disabled={!preview.data}
          >
            {showEmail ? 'Hide' : 'Preview'} report email
          </Button>
        }
      />
      {preview.isPending && <Loading />}
      {preview.error && <ErrorState error={preview.error} retry={() => void preview.refetch()} />}
      {preview.data && (
        <>
          {showEmail && (
            <Card title={preview.data.email.subject} className="mb-6">
              <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700">
                {preview.data.email.text}
              </pre>
            </Card>
          )}
          <Funnel d={preview.data.data} />
        </>
      )}

      <Card title="Sent reports" className="mt-6">
        {history.isPending && <Loading />}
        {history.data && !history.data.length && (
          <Empty title="No weekly report yet">The first one goes out on the next report day.</Empty>
        )}
        <ul className="-my-2 divide-y divide-slate-100">
          {history.data?.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="font-medium text-slate-800">{r.data.period.label}</span>
              <span className="text-slate-600">
                {r.data.leads} leads · {r.data.booked} booked · {r.data.shows} visits ·{' '}
                {fmt.inr(r.data.revenueRecoveredInr)}
              </span>
              <span className={cx('text-xs', r.error ? 'text-red-700' : 'text-slate-400')}>
                {r.error ? `not sent: ${r.error}` : r.sentAt ? `sent ${fmt.dateTime(r.sentAt)}` : 'pending'}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Funnel({ d }: { d: ReportData }) {
  const steps = [
    ['Enquiries', d.leads],
    ['Replied', d.repliedLeads],
    ['Qualified', d.qualified],
    ['Booked', d.booked],
    ['Visited', d.shows],
  ] as const;
  const max = Math.max(1, ...steps.map(([, v]) => v));
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card title={`Last 7 days · ${d.period.label}`}>
        <ul className="space-y-2.5">
          {steps.map(([label, value]) => (
            <li key={label} className="grid grid-cols-[6rem_1fr_3rem] items-center gap-3 text-sm">
              <span className="text-slate-600">{label}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                <span
                  className="block h-full rounded-full bg-brand-600"
                  style={{ width: `${(value / max) * 100}%` }}
                />
              </span>
              <span className="text-right font-semibold tabular-nums">{value}</span>
            </li>
          ))}
        </ul>
        {d.topTopics.length > 0 && (
          <p className="mt-4 text-xs text-slate-500">
            Asked about: {d.topTopics.map((t) => `${t.topic} (${t.count})`).join(', ')}
          </p>
        )}
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
        {[
          ['First reply (median)', secs(d.medianFirstResponseSec)],
          ['Show rate', pct(d.showRate)],
          ['Revenue from visits', fmt.inr(d.revenueRecoveredInr)],
          ['Upcoming bookings', String(d.upcomingBookings)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
