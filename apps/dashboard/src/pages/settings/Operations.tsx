import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { Badge, Button, Card, ErrorState, Field, fmt, Input, Loading, Select } from '../../ui.tsx';

interface Rule {
  weekday: string;
  start_time: string;
  end_time: string;
  resource: string;
}
interface Affected {
  id: string;
  leadName: string | null;
  leadPhone: string;
  service: string;
  resource: string;
  startsAt: string;
}
interface Blocked {
  id: string;
  startsAt: string;
  endsAt: string;
  resource: string | null;
  reason: string | null;
  /** Bookings still inside this block: they haven't been told yet. */
  affected: Affected[];
}
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Weekly bookable hours per resource (chair / doctor) and one-off blocked times. */
export function Availability({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['availability'],
    queryFn: () =>
      api<{
        rules: { weekday: string; startTime: string; endTime: string; resource: string }[];
        blocked: Blocked[];
      }>('/v1/availability'),
  });
  const [rules, setRules] = useState<Rule[] | null>(null);
  useEffect(() => {
    if (q.data)
      setRules(
        q.data.rules.map((r) => ({
          weekday: r.weekday,
          start_time: r.startTime,
          end_time: r.endTime,
          resource: r.resource,
        })),
      );
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('/v1/availability', { method: 'PUT', body: rules }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['availability'] }),
  });
  const [block, setBlock] = useState({ start: '', end: '', reason: '', resource: '' });
  const addBlock = useMutation({
    mutationFn: () =>
      api('/v1/blocked-times', {
        body: {
          starts_at: new Date(block.start).toISOString(),
          ends_at: new Date(block.end).toISOString(),
          reason: block.reason || undefined,
          resource: block.resource || undefined,
        },
      }),
    onSuccess: () => {
      setBlock({ start: '', end: '', reason: '', resource: '' });
      return qc.invalidateQueries({ queryKey: ['availability'] });
    },
  });
  const notify = useMutation({
    mutationFn: (id: string) =>
      api<{ results: { action: 'moved' | 'notified'; to?: string }[] }>(`/v1/blocked-times/${id}/notify`, {
        method: 'POST',
      }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['availability'] }),
        qc.invalidateQueries({ queryKey: ['appointments'] }),
      ]),
  });
  const removeBlock = useMutation({
    mutationFn: (id: string) => api(`/v1/blocked-times/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['availability'] }),
  });

  if (q.isPending || !rules)
    return (
      <Card title="Bookable hours">
        <Loading />
      </Card>
    );
  if (q.error) return <ErrorState error={q.error} />;
  const set = (i: number, patch: Partial<Rule>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
      <Card
        title="Bookable hours"
        actions={
          canEdit && (
            <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
              Save hours
            </Button>
          )
        }
      >
        <p className="mb-3 text-xs text-slate-500">
          One row per day and resource. Add a second resource (e.g. "Dr Mehta" or "Chair 2") to take two
          bookings at the same time.
        </p>
        <div className="space-y-2">
          {rules.map((r, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Field label="Day">
                <Select
                  value={r.weekday}
                  onChange={(e) => set(i, { weekday: e.target.value })}
                  className="w-24 capitalize"
                >
                  {DAYS.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </Select>
              </Field>
              <Field label="From">
                <Input
                  type="time"
                  value={r.start_time}
                  onChange={(e) => set(i, { start_time: e.target.value })}
                />
              </Field>
              <Field label="To">
                <Input
                  type="time"
                  value={r.end_time}
                  onChange={(e) => set(i, { end_time: e.target.value })}
                />
              </Field>
              <Field label="Resource">
                <Input
                  value={r.resource}
                  onChange={(e) => set(i, { resource: e.target.value })}
                  className="w-36"
                />
              </Field>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Remove row"
                onClick={() => setRules(rules.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setRules([
                ...rules,
                { weekday: 'mon', start_time: '10:00', end_time: '18:00', resource: 'default' },
              ])
            }
          >
            <Plus className="size-3.5" aria-hidden /> Add row
          </Button>
          {save.error && <ErrorState error={save.error} />}
        </div>
      </Card>

      <Card title="Blocked times (leave, holidays)">
        <ul className="mb-3 space-y-1.5 text-sm">
          {q.data.blocked.length === 0 && <li className="text-slate-500">Nothing blocked.</li>}
          {q.data.blocked.map((b) => (
            <li key={b.id} className="rounded-lg border border-slate-100 p-2">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {fmt.dateTime(b.startsAt)} – {fmt.dateTime(b.endsAt)} · {b.resource ?? 'everyone'}{' '}
                  {b.reason && <Badge>{b.reason}</Badge>}
                </span>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Remove blocked time"
                    onClick={() => removeBlock.mutate(b.id)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                )}
              </div>
              {b.affected.length > 0 && (
                <div className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                  <p className="font-medium">
                    {b.affected.length} booking{b.affected.length === 1 ? '' : 's'} inside this time — not
                    told yet:
                  </p>
                  <ul className="my-1 list-inside list-disc">
                    {b.affected.map((a) => (
                      <li key={a.id}>
                        {a.leadName ?? a.leadPhone}: {a.service}, {fmt.dateTime(a.startsAt)}
                        {a.resource !== 'default' ? ` (${a.resource})` : ''}
                      </li>
                    ))}
                  </ul>
                  {canEdit && (
                    <Button
                      size="sm"
                      loading={notify.isPending && notify.variables === b.id}
                      onClick={() =>
                        confirm(
                          'Move each booking to another free doctor at the same time where possible; otherwise cancel it and message them with new times to choose from?',
                        ) && notify.mutate(b.id)
                      }
                    >
                      Tell them & offer new times
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From">
              <Input
                type="datetime-local"
                value={block.start}
                onChange={(e) => setBlock({ ...block, start: e.target.value })}
              />
            </Field>
            <Field label="To">
              <Input
                type="datetime-local"
                value={block.end}
                onChange={(e) => setBlock({ ...block, end: e.target.value })}
              />
            </Field>
            <Field label="Who">
              <Select
                value={block.resource}
                onChange={(e) => setBlock({ ...block, resource: e.target.value })}
              >
                <option value="">Everyone (closed)</option>
                {[...new Set(rules.map((r) => r.resource))].map((r) => (
                  <option key={r} value={r}>
                    {r === 'default' ? 'Main calendar' : r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason">
              <Input value={block.reason} onChange={(e) => setBlock({ ...block, reason: e.target.value })} />
            </Field>
            <Button
              size="sm"
              disabled={!block.start || !block.end}
              loading={addBlock.isPending}
              onClick={() => addBlock.mutate()}
            >
              Block
            </Button>
          </div>
        )}
        {notify.data && (
          <p className="mt-2 text-sm text-slate-600">
            Done: {notify.data.results.filter((r) => r.action === 'moved').length} moved to another free
            doctor, {notify.data.results.filter((r) => r.action === 'notified').length} messaged with new
            times.
          </p>
        )}
        {notify.error && <ErrorState error={notify.error} />}
        {addBlock.error && (
          <div className="mt-2">
            <ErrorState error={addBlock.error} />
          </div>
        )}
      </Card>
    </>
  );
}

interface TemplateRow {
  key: string;
  language: string;
  providerName: string;
  category: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
}
const STATUS_TONE = {
  draft: 'bg-slate-100 text-slate-600 ring-slate-200',
  submitted: 'bg-amber-50 text-amber-800 ring-amber-200',
  approved: 'bg-brand-50 text-brand-700 ring-brand-100',
  rejected: 'bg-red-50 text-red-700 ring-red-200',
};

/** WhatsApp template approval status (the client submits them in WhatsApp Manager). */
export function Templates({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['templates'], queryFn: () => api<TemplateRow[]>('/v1/templates') });
  const update = useMutation({
    mutationFn: (t: { key: string; language: string; status: string }) =>
      api(`/v1/templates/${t.key}/${t.language}`, { method: 'PUT', body: { status: t.status } }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['templates'] }),
        qc.invalidateQueries({ queryKey: ['onboarding'] }),
      ]),
  });
  return (
    <Card
      title="WhatsApp templates"
      actions={
        <span className="text-xs text-slate-500">Submit them as listed in TEMPLATES-TO-SUBMIT.md</span>
      }
    >
      {q.isPending && <Loading />}
      {q.error && <ErrorState error={q.error} />}
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Language</th>
              <th className="px-2 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.data?.map((t) => (
              <tr key={`${t.key}-${t.language}`}>
                <td className="px-4 py-2 font-mono text-xs">{t.providerName}</td>
                <td className="px-2 py-2">{t.language}</td>
                <td className="px-2 py-2">{t.category}</td>
                <td className="px-4 py-2">
                  {canEdit ? (
                    <Select
                      value={t.status}
                      className="w-32 py-1 text-xs"
                      onChange={(e) =>
                        update.mutate({ key: t.key, language: t.language, status: e.target.value })
                      }
                      aria-label={`${t.providerName} ${t.language} status`}
                    >
                      {Object.keys(STATUS_TONE).map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </Select>
                  ) : (
                    <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
