import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Phone, Plus, Settings2, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, type TenantConfig } from '../api.ts';
import { Badge, Button, cx, ErrorState, Field, fmt, Input, Loading, Select, Textarea } from '../ui.tsx';

interface TimelineEntry {
  at: string;
  stage: string;
  channel: string;
  title: string;
  detail?: string | null;
}
type PlanStatus = 'proposed' | 'accepted' | 'in_progress' | 'completed' | 'declined';
interface Plan {
  id: string;
  title: string;
  service: string | null;
  attendeeName: string | null;
  status: PlanStatus;
  visitsPlanned: number | null;
  visitsDone: number;
  visitIntervalDays: number | null;
  nextVisitDueAt: string | null;
  recallDueAt: string | null;
  valueInr: number | null;
  paidInr: number | null;
  notes: string | null;
}
interface Installment {
  id: string;
  planId: string;
  seq: number;
  amountInr: number;
  dueAt: string;
  status: 'pending' | 'paid' | 'waived';
  paidAt: string | null;
}

const STAGE_TONE: Record<string, string> = {
  booking: 'bg-brand-50 text-brand-700 ring-brand-100',
  confirmation: 'bg-brand-50 text-brand-700 ring-brand-100',
  attendance: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  cancellation: 'bg-slate-100 text-slate-500 ring-slate-200',
  no_show: 'bg-orange-50 text-orange-700 ring-orange-200',
  treatment: 'bg-violet-50 text-violet-700 ring-violet-200',
  human: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200',
  consent: 'bg-red-50 text-red-700 ring-red-200',
  payment: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
};
const CHANNEL_ICON = { whatsapp: MessageCircle, phone: Phone, staff: User, system: Settings2 } as const;
const STATUSES: [PlanStatus, string][] = [
  ['proposed', 'Proposed'],
  ['accepted', 'Accepted'],
  ['in_progress', 'In progress'],
  ['completed', 'Completed'],
  ['declined', 'Declined'],
];

/**
 * One patient across WhatsApp, phone, web and staff actions, plus the clinic's treatment plans. Plans are
 * the administrative journey only (visits, due dates, amounts the clinic entered), never clinical notes by the AI.
 */
export function Journey({ leadId, config }: { leadId: string; config: TenantConfig }) {
  const tz = config.locale.timezone;
  const q = useQuery({
    queryKey: ['timeline', leadId],
    queryFn: () =>
      api<{ entries: TimelineEntry[]; plans: Plan[]; installments: Installment[] }>(
        `/v1/leads/${leadId}/timeline`,
      ),
    refetchInterval: 15_000,
  });
  const [showComms, setShowComms] = useState(false);
  const [adding, setAdding] = useState(false);
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const entries = q.data.entries.filter(
    (e) => showComms || e.stage !== 'communication' || e.channel === 'phone',
  );

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Treatment plans</h3>
          <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
            <Plus className="size-3.5" aria-hidden /> Add plan
          </Button>
        </div>
        {adding && <PlanForm leadId={leadId} config={config} onDone={() => setAdding(false)} />}
        {!q.data.plans.length && !adding && (
          <p className="text-sm text-slate-500">
            No treatment plan recorded. Add one after the consultation to track visits, recalls and balances.
          </p>
        )}
        <ul className="space-y-2">
          {q.data.plans.map((p) => (
            <PlanRow
              key={p.id}
              plan={p}
              installments={q.data.installments.filter((i) => i.planId === p.id)}
              leadId={leadId}
              config={config}
              tz={tz}
            />
          ))}
        </ul>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Timeline</h3>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={showComms} onChange={(e) => setShowComms(e.target.checked)} />
            Show every message
          </label>
        </div>
        {!entries.length ? (
          <p className="text-sm text-slate-500">Nothing yet.</p>
        ) : (
          <ol className="relative space-y-3 border-l border-slate-200 pl-4">
            {entries.map((e, i) => {
              const Icon = CHANNEL_ICON[e.channel as keyof typeof CHANNEL_ICON] ?? Settings2;
              return (
                <li key={i} className="relative">
                  <span className="absolute -left-[1.4rem] top-0.5 flex size-5 items-center justify-center rounded-full bg-white ring-1 ring-slate-200">
                    <Icon className="size-3 text-slate-500" aria-label={e.channel} />
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{e.title}</span>
                    {e.stage !== 'communication' && (
                      <Badge tone={STAGE_TONE[e.stage]}>{e.stage.replace('_', ' ')}</Badge>
                    )}
                    <span className="text-xs text-slate-500">{fmt.dateTime(e.at, tz)}</span>
                  </div>
                  {e.detail && (
                    <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm text-slate-600">
                      {e.detail}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function PlanRow({
  plan,
  installments,
  leadId,
  config,
  tz,
}: {
  plan: Plan;
  installments: Installment[];
  leadId: string;
  config: TenantConfig;
  tz: string;
}) {
  const [editing, setEditing] = useState(false);
  const due = plan.valueInr !== null && plan.paidInr !== null ? plan.valueInr - plan.paidInr : null;
  if (editing)
    return <PlanForm leadId={leadId} config={config} plan={plan} onDone={() => setEditing(false)} />;
  return (
    <li className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-900">{plan.title}</span>
        {plan.attendeeName && <span className="text-xs text-slate-500">for {plan.attendeeName}</span>}
        <Badge tone={STAGE_TONE.treatment}>{plan.status.replace('_', ' ')}</Badge>
        <button className="ml-auto text-xs text-brand-700 hover:underline" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        Visits {plan.visitsDone}
        {plan.visitsPlanned ? ` of ${plan.visitsPlanned}` : ''}
        {plan.nextVisitDueAt ? ` · next due ${fmt.dateTime(plan.nextVisitDueAt, tz)}` : ''}
        {plan.recallDueAt ? ` · recall ${fmt.dateTime(plan.recallDueAt, tz)}` : ''}
        {plan.valueInr !== null ? ` · ${fmt.inr(plan.valueInr)} total` : ''}
        {due !== null ? ` · ${due > 0 ? `${fmt.inr(due)} pending` : 'paid'}` : ''}
      </p>
      <Schedule plan={plan} installments={installments} leadId={leadId} config={config} tz={tz} />
    </li>
  );
}

/** The plan's payment schedule (braces, implants): set up or re-plan, and record each payment. */
function Schedule({
  plan,
  installments,
  leadId,
  config,
  tz,
}: {
  plan: Plan;
  installments: Installment[];
  leadId: string;
  config: TenantConfig;
  tz: string;
}) {
  const qc = useQueryClient();
  const tpl = config.treatment_templates?.find((t) => t.name === plan.title)?.installments;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    count: String(tpl?.count ?? 6),
    first_due: '',
    interval_days: String(tpl?.interval_days ?? 30),
    amount_inr: '',
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['timeline', leadId] });
  const create = useMutation({
    mutationFn: () =>
      api(`/v1/treatment-plans/${plan.id}/installments`, {
        body: {
          count: Number(f.count),
          first_due: f.first_due,
          interval_days: Number(f.interval_days),
          ...(f.amount_inr ? { amount_inr: Number(f.amount_inr) } : {}),
        },
      }),
    onSuccess: async () => {
      setOpen(false);
      await refresh();
    },
  });
  const mark = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Installment['status'] }) =>
      api(`/v1/installments/${id}`, { method: 'PATCH', body: { status } }),
    onSettled: refresh,
  });
  const now = Date.now();
  const next = installments.find((i) => i.status === 'pending');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-slate-700">Payment schedule</span>
        {installments.length > 0 && (
          <span className="text-slate-500">
            {installments.filter((i) => i.status === 'paid').length} of {installments.length} paid
            {next ? ` · next ${fmt.inr(next.amountInr)} due ${shortDate(next.dueAt, tz)}` : ''}
          </span>
        )}
        <button className="ml-auto text-brand-700 hover:underline" onClick={() => setOpen((v) => !v)}>
          {installments.length ? 'Re-plan' : 'Set up instalments'}
        </button>
      </div>
      {open && (
        <form
          className="mt-2 grid gap-2 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Instalments">
            <Input type="number" min={1} max={60} required value={f.count} onChange={set('count')} />
          </Field>
          <Field label="First due">
            <Input type="date" required value={f.first_due} onChange={set('first_due')} />
          </Field>
          <Field label="Every (days)">
            <Input
              type="number"
              min={7}
              max={365}
              required
              value={f.interval_days}
              onChange={set('interval_days')}
            />
          </Field>
          <Field label="₹ each (optional)" hint="Empty: what is owed, split evenly">
            <Input type="number" min={1} value={f.amount_inr} onChange={set('amount_inr')} />
          </Field>
          <div className="flex items-center justify-end gap-2 sm:col-span-4">
            {installments.some((i) => i.status !== 'pending') && (
              <span className="mr-auto text-xs text-slate-500">Paid instalments are kept.</span>
            )}
            {create.error && <span className="text-xs text-red-700">{create.error.message}</span>}
            <Button size="sm" type="submit" loading={create.isPending}>
              Save schedule
            </Button>
          </div>
        </form>
      )}
      {installments.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100 text-xs">
          {installments.map((i) => {
            const overdue = i.status === 'pending' && new Date(i.dueAt).getTime() < now;
            return (
              <li key={i.id} className={cx('flex items-center gap-2 py-1', overdue && 'text-red-700')}>
                <span className="w-6 tabular-nums text-slate-400">{i.seq}</span>
                <span className="w-20 font-medium tabular-nums">{fmt.inr(i.amountInr)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {i.status === 'paid'
                    ? `paid ${i.paidAt ? shortDate(i.paidAt, tz) : ''}`
                    : i.status === 'waived'
                      ? 'waived'
                      : `${overdue ? 'overdue since' : 'due'} ${shortDate(i.dueAt, tz)}`}
                </span>
                {i.status === 'pending' ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => mark.mutate({ id: i.id, status: 'paid' })}
                    >
                      Paid
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => mark.mutate({ id: i.id, status: 'waived' })}
                    >
                      Waive
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => mark.mutate({ id: i.id, status: 'pending' })}
                  >
                    Undo
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {mark.error && <p className="text-xs text-red-700">{mark.error.message}</p>}
    </div>
  );
}

/** "20 Oct 26": fits a phone row next to the buttons. */
const shortDate = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: tz }).format(
    new Date(iso),
  );
const iso = (d: string) => (d ? new Date(`${d}T09:00:00+05:30`).toISOString() : null);
const dateOf = (s: string | null) => (s ? s.slice(0, 10) : '');
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

function PlanForm({
  leadId,
  config,
  plan,
  onDone,
}: {
  leadId: string;
  config: TenantConfig;
  plan?: Plan;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    title: plan?.title ?? '',
    service: plan?.service ?? '',
    attendee_name: plan?.attendeeName ?? '',
    status: plan?.status ?? ('accepted' as PlanStatus),
    visits_planned: plan?.visitsPlanned?.toString() ?? '',
    visits_done: plan?.visitsDone.toString() ?? '0',
    visit_interval_days: plan?.visitIntervalDays?.toString() ?? '',
    next_visit_due_at: dateOf(plan?.nextVisitDueAt ?? null),
    value_inr: plan?.valueInr?.toString() ?? '',
    paid_inr: plan?.paidInr?.toString() ?? '',
    notes: plan?.notes ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: f.title,
        service: f.service || null,
        attendee_name: f.attendee_name.trim() || null,
        status: f.status,
        visits_planned: numOrNull(f.visits_planned),
        visits_done: Number(f.visits_done || 0),
        visit_interval_days: numOrNull(f.visit_interval_days),
        next_visit_due_at: iso(f.next_visit_due_at),
        value_inr: numOrNull(f.value_inr),
        paid_inr: numOrNull(f.paid_inr),
        notes: f.notes.trim() || null,
      };
      return plan
        ? api(`/v1/treatment-plans/${plan.id}`, { method: 'PATCH', body })
        : api(`/v1/leads/${leadId}/treatment-plans`, { body });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['timeline', leadId] });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form
      onSubmit={submit}
      className={cx('mb-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3')}
    >
      {!plan && (config.treatment_templates?.length ?? 0) > 0 && (
        <Field label="Start from a template (optional)">
          <Select
            defaultValue=""
            onChange={(e) => {
              const t = config.treatment_templates?.find((x) => x.name === e.target.value);
              if (t)
                setF((x) => ({
                  ...x,
                  title: t.name,
                  service: t.service ?? '',
                  visits_planned: t.visits_planned?.toString() ?? '',
                  visit_interval_days: t.visit_interval_days?.toString() ?? '',
                  value_inr: t.value_inr?.toString() ?? x.value_inr,
                }));
            }}
          >
            <option value="">— type your own —</option>
            {config.treatment_templates?.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Treatment (your wording)">
          <Input
            required
            minLength={2}
            value={f.title}
            onChange={set('title')}
            placeholder="Root canal, 3 visits"
          />
        </Field>
        <Field label="Service to book for each visit">
          <Select value={f.service} onChange={set('service')}>
            <option value="">—</option>
            {config.booking.services.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={set('status')}>
            {STATUSES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="For (family member, optional)">
          <Input value={f.attendee_name} onChange={set('attendee_name')} />
        </Field>
        <Field label="Visits planned / done">
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              max={50}
              value={f.visits_planned}
              onChange={set('visits_planned')}
              aria-label="Visits planned"
            />
            <Input
              type="number"
              min={0}
              max={50}
              value={f.visits_done}
              onChange={set('visits_done')}
              aria-label="Visits done"
            />
          </div>
        </Field>
        <Field label="Days between visits" hint="Sets the next due date after each completed visit">
          <Input
            type="number"
            min={1}
            max={365}
            value={f.visit_interval_days}
            onChange={set('visit_interval_days')}
          />
        </Field>
        <Field label="Next visit due">
          <Input type="date" value={f.next_visit_due_at} onChange={set('next_visit_due_at')} />
        </Field>
        <Field label="Total / paid (₹, optional)" hint="Leave empty if unknown: nothing is ever estimated">
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              value={f.value_inr}
              onChange={set('value_inr')}
              aria-label="Total amount"
            />
            <Input
              type="number"
              min={0}
              value={f.paid_inr}
              onChange={set('paid_inr')}
              aria-label="Amount paid"
            />
          </div>
        </Field>
      </div>
      <Field label="Admin notes (not shown to the assistant)">
        <Textarea rows={2} value={f.notes} onChange={set('notes')} />
      </Field>
      {save.error && <p className="text-xs text-red-700">{save.error.message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={save.isPending}>
          Save plan
        </Button>
      </div>
    </form>
  );
}
