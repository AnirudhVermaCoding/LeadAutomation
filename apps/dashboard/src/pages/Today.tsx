import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleSlash, Clock, UserCheck, X } from 'lucide-react';
import { useState } from 'react';
import { api, type Appointment, type Role, type TenantConfig } from '../api.ts';
import { navigate } from '../router.ts';
import { Badge, Button, Card, cx, Empty, ErrorState, fmt, Loading, PageHeader, Select } from '../ui.tsx';

const STATUS_TONE: Record<Appointment['status'], string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  scheduled: 'bg-sky-50 text-sky-700 ring-sky-200',
  confirmed: 'bg-brand-50 text-brand-700 ring-brand-100',
  completed: 'bg-slate-100 text-slate-600 ring-slate-200',
  no_show: 'bg-orange-50 text-orange-700 ring-orange-200',
  cancelled: 'bg-slate-100 text-slate-400 ring-slate-200',
};

export function Today({ config }: { config: TenantConfig; role: Role }) {
  const tz = config.locale.timezone;
  const qc = useQueryClient();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 3 * 86_400_000);
  // A week back too: earlier visits nobody marked Completed / No-show stay here until they are.
  const from = new Date(start.getTime() - 7 * 86_400_000);
  const key = ['appointments', start.toISOString()];
  const appts = useQuery({
    queryKey: key,
    queryFn: () => api<Appointment[]>(`/v1/appointments?from=${from.toISOString()}&to=${end.toISOString()}`),
    refetchInterval: 30_000,
  });
  // Bookings inside blocked time (leave / closure) that nobody has told yet.
  const blocked = useQuery({
    queryKey: ['availability'],
    queryFn: () => api<{ blocked: { affected: unknown[] }[] }>('/v1/availability'),
  });
  const untold = (blocked.data?.blocked ?? []).reduce((n, b) => n + b.affected.length, 0);
  const [lateBy, setLateBy] = useState(15);
  const late = useMutation({
    mutationFn: () =>
      api<{ notified: number }>('/v1/appointments/running-late', { body: { minutes: lateBy } }),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'confirm' | 'complete' | 'no-show' | 'cancel' }) =>
      api(`/v1/appointments/${id}/${action}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['appointments'] }),
  });

  const now = Date.now();
  const active = (a: Appointment) => ['pending', 'scheduled', 'confirmed'].includes(a.status);
  /** The visit is over but nobody marked it: no review request or rebooking message can go out. */
  const unmarked = (a: Appointment) => active(a) && new Date(a.endsAt).getTime() < now;
  const visible = (appts.data ?? []).filter(
    (a) => a.status !== 'cancelled' && (new Date(a.startsAt) >= start || unmarked(a)),
  );
  const byDay = Map.groupBy(visible, (a) => fmt.day(a.startsAt, tz));
  const pending = visible.filter((a) => a.status === 'pending').length;
  const toMark = visible.filter(unmarked).length;
  const autoConfirm =
    config.booking.mode === 'staff_confirm' && (config.booking.auto_confirm_pending ?? true);

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={
          appts.data
            ? `${visible.length} appointments${pending ? ` · ${pending} waiting for your confirmation` : ''}${toMark ? ` · ${toMark} to mark Completed / No-show` : ''}`
            : undefined
        }
        actions={
          <span className="flex items-center gap-1.5">
            <Select
              aria-label="How late"
              value={lateBy}
              onChange={(e) => setLateBy(Number(e.target.value))}
              className="w-28"
            >
              {[15, 30, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              loading={late.isPending}
              onClick={() =>
                confirm(
                  `Message everyone still booked today that you are running about ${lateBy} minutes late?`,
                ) && late.mutate()
              }
            >
              <Clock className="size-3.5" aria-hidden /> Running late
            </Button>
          </span>
        }
      />
      {late.data && (
        <p className="mb-4 text-sm text-slate-600">
          Told {late.data.notified} {late.data.notified === 1 ? 'person' : 'people'} booked later today.
        </p>
      )}
      {late.error && <ErrorState error={late.error} />}
      {appts.isPending && <Loading />}
      {appts.error && <ErrorState error={appts.error} retry={() => void appts.refetch()} />}
      {untold > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {untold} booking{untold === 1 ? ' is' : 's are'} inside blocked time (leave or closure) and{' '}
          {untold === 1 ? 'has' : 'have'} not been told.{' '}
          <button className="font-medium underline" onClick={() => navigate('/settings')}>
            Review in Settings → Booking
          </button>
        </div>
      )}
      {act.error && (
        <div className="mb-4">
          <ErrorState error={act.error} />
        </div>
      )}
      {appts.data && !visible.length && (
        <Card>
          <Empty title="No appointments yet">New bookings from WhatsApp will appear here.</Empty>
        </Card>
      )}
      <div className="space-y-5">
        {[...byDay.entries()].map(([day, list]) => (
          <Card key={day} title={day}>
            <ul className="divide-y divide-slate-100">
              {list.map((a) => (
                <li
                  key={a.id}
                  className={cx(
                    'flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0',
                    unmarked(a) && '-mx-2 rounded-lg bg-amber-50 px-2',
                  )}
                >
                  <div className="w-20 shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {fmt.time(a.startsAt, tz)}
                  </div>
                  <button
                    className="min-w-40 flex-1 text-left"
                    onClick={() => navigate(`/inbox?lead=${a.leadId}`)}
                  >
                    <p className="truncate text-sm font-medium text-slate-900">{a.leadName ?? a.leadPhone}</p>
                    <p className="truncate text-xs text-slate-500">
                      {a.service}
                      {a.resource !== 'default' ? ` · ${a.resource}` : ''}
                    </p>
                  </button>
                  <Badge tone={STATUS_TONE[a.status]}>
                    {unmarked(a)
                      ? 'needs marking'
                      : a.status === 'scheduled'
                        ? 'booked'
                        : a.status.replace('_', '-')}
                  </Badge>
                  {a.status === 'pending' && autoConfirm && !unmarked(a) && (
                    <span className="text-xs text-amber-700">auto-confirms if not confirmed in time</span>
                  )}
                  <div className="flex gap-1.5">
                    {a.status === 'pending' && !unmarked(a) && (
                      <Button size="sm" onClick={() => act.mutate({ id: a.id, action: 'confirm' })}>
                        <Check className="size-3.5" aria-hidden /> Confirm
                      </Button>
                    )}
                    {(a.status === 'scheduled' || a.status === 'confirmed' || unmarked(a)) && (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => act.mutate({ id: a.id, action: 'complete' })}
                        >
                          <UserCheck className="size-3.5" aria-hidden /> Completed
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => act.mutate({ id: a.id, action: 'no-show' })}
                        >
                          <CircleSlash className="size-3.5" aria-hidden /> No-show
                        </Button>
                      </>
                    )}
                    {['pending', 'scheduled', 'confirmed'].includes(a.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Cancel appointment"
                        onClick={() =>
                          confirm('Cancel this appointment? They will be told.') &&
                          act.mutate({ id: a.id, action: 'cancel' })
                        }
                      >
                        <X className="size-3.5" aria-hidden />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
