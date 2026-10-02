import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { navigate } from '../router.ts';
import {
  Button,
  Card,
  cx,
  Empty,
  ErrorState,
  Field,
  fmt,
  Input,
  Loading,
  PageHeader,
  Select,
} from '../ui.tsx';

interface Usage {
  since: string;
  tenants: {
    tenantId: string;
    name: string;
    slug: string;
    leads: number;
    messagesOut: number;
    whatsappInr: number;
    llmUsd: number;
    llmCapUsd: number;
    llmProviders: string;
    bookings: number;
  }[];
}
const PRESETS = [
  ['clinic_dental', 'Dental clinic'],
  ['clinic_skin', 'Skin clinic'],
  ['clinic_hair', 'Hair clinic'],
  ['real_estate', 'Real estate'],
] as const;
const USD_TO_INR = 88; // display only, for a rough per-tenant total

export function Agency({ onSwitch }: { onSwitch: (tenantId: string) => void }) {
  const qc = useQueryClient();
  const usage = useQuery({
    queryKey: ['usage'],
    queryFn: () => api<Usage>('/v1/admin/usage'),
    refetchInterval: 60_000,
  });
  const [form, setForm] = useState({
    name: '',
    slug: '',
    preset: 'clinic_dental',
    adminEmail: '',
    adminName: '',
    adminPassword: '',
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ tenant: { id: string } }>('/v1/admin/tenants', {
        body: {
          name: form.name,
          slug: form.slug,
          preset: form.preset,
          ...(form.adminEmail
            ? {
                admin: {
                  email: form.adminEmail,
                  name: form.adminName || form.name,
                  password: form.adminPassword,
                },
              }
            : {}),
        },
      }),
    onSuccess: async ({ tenant }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['tenants'] }),
        qc.invalidateQueries({ queryKey: ['usage'] }),
      ]);
      onSwitch(tenant.id);
      navigate('/settings');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <>
      <PageHeader
        title="Agency"
        subtitle={usage.data ? `Usage since ${fmt.dateTime(usage.data.since)}` : undefined}
      />
      <Card title="Clients" className="mb-6">
        {usage.isPending && <Loading />}
        {usage.error && <ErrorState error={usage.error} />}
        {usage.data && !usage.data.tenants.length && <Empty title="No clients yet" />}
        {usage.data && usage.data.tenants.length > 0 && (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-2 py-2 text-right font-medium">Leads</th>
                  <th className="px-2 py-2 text-right font-medium">Bookings</th>
                  <th className="px-2 py-2 text-right font-medium">WhatsApp sent</th>
                  <th className="px-2 py-2 text-right font-medium">WhatsApp cost</th>
                  <th className="px-2 py-2 text-right font-medium">AI cost</th>
                  <th className="px-2 py-2 text-right font-medium">AI budget</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {usage.data.tenants.map((t) => (
                  <tr key={t.tenantId}>
                    <td className="px-4 py-2">
                      <p className="font-medium text-slate-900">{t.name}</p>
                      <p className="text-xs text-slate-500">{t.slug}</p>
                    </td>
                    <td className="px-2 py-2 text-right">{t.leads}</td>
                    <td className="px-2 py-2 text-right">{t.bookings}</td>
                    <td className="px-2 py-2 text-right">{t.messagesOut}</td>
                    <td className="px-2 py-2 text-right">{fmt.inr(t.whatsappInr)}</td>
                    <td className="px-2 py-2 text-right" title={`$${t.llmUsd.toFixed(2)}`}>
                      {fmt.inr(t.llmUsd * USD_TO_INR)}
                    </td>
                    <td
                      className={cx(
                        'px-2 py-2 text-right',
                        t.llmCapUsd > 0 && t.llmUsd >= 0.8 * t.llmCapUsd && 'font-semibold text-amber-700',
                      )}
                      title={t.llmProviders ? `Providers: ${t.llmProviders}` : 'No AI calls yet'}
                    >
                      {t.llmCapUsd > 0
                        ? `${Math.round((t.llmUsd / t.llmCapUsd) * 100)}% of ${t.llmCapUsd}`
                        : 'no cap'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          onSwitch(t.tenantId);
                          navigate('/');
                        }}
                      >
                        Open <ArrowRight className="size-3.5" aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Monitoring />

      <Card title="New client from a preset">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
          <Field label="Business name">
            <Input
              required
              value={form.name}
              onChange={(e) =>
                setForm({
                  ...form,
                  name: e.target.value,
                  slug:
                    form.slug ||
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, '')
                      .slice(0, 40),
                })
              }
            />
          </Field>
          <Field label="Short id (slug)" hint="lowercase letters, digits, dashes">
            <Input
              required
              pattern="[a-z0-9][a-z0-9-]{1,40}"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </Field>
          <Field label="Preset">
            <Select value={form.preset} onChange={(e) => setForm({ ...form, preset: e.target.value })}>
              {PRESETS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Client admin email (optional)">
            <Input
              type="email"
              value={form.adminEmail}
              onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
            />
          </Field>
          <Field label="Client admin name">
            <Input value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} />
          </Field>
          <Field label="Temporary password" hint="12+ characters; share it securely">
            <Input
              type="password"
              minLength={12}
              required={Boolean(form.adminEmail)}
              value={form.adminPassword}
              onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          {create.error && (
            <div className="sm:col-span-3">
              <ErrorState error={create.error} />
            </div>
          )}
          <div className="sm:col-span-3">
            <Button type="submit" loading={create.isPending}>
              Create client
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

interface MonitoringData {
  alerts: { id: string; kind: string; message: string; lastSeenAt: string; lastSentAt: string | null }[];
  deadLetters: {
    id: string;
    source_name: string | null;
    data: unknown;
    source_output: unknown;
    created_on: string;
  }[];
}

function Monitoring() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['monitoring'],
    queryFn: () => api<MonitoringData>('/v1/admin/monitoring'),
    refetchInterval: 60_000,
  });
  const dead = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'retry' | 'discard' }) =>
      api(`/v1/admin/dead-letter/${id}/${action}`, { method: 'POST', body: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['monitoring'] }),
  });
  const run = useMutation({
    mutationFn: () => api<{ found: number; emailed: number }>('/v1/admin/monitoring/run', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitoring'] }),
  });
  return (
    <Card
      title="Monitoring"
      className="mb-6"
      actions={
        <Button size="sm" variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>
          Run checks now
        </Button>
      }
    >
      {q.isPending && <Loading />}
      {q.error && <ErrorState error={q.error} />}
      {run.data && (
        <p className="mb-3 text-sm text-slate-600">
          {run.data.found} issue(s) found, {run.data.emailed} alert email(s) sent.
        </p>
      )}
      {q.data && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Alerts</h3>
            {!q.data.alerts.length && <p className="text-sm text-slate-500">All quiet.</p>}
            <ul className="space-y-2 text-sm">
              {q.data.alerts.map((a) => (
                <li key={a.id} className="rounded-lg bg-amber-50 p-2 text-amber-900">
                  {a.message}
                  <span className="block text-xs text-amber-700">last seen {fmt.ago(a.lastSeenAt)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Failed jobs (dead letter)
            </h3>
            {!q.data.deadLetters.length && <p className="text-sm text-slate-500">None.</p>}
            <ul className="space-y-2 text-xs">
              {q.data.deadLetters.map((d) => (
                <li key={d.id} className="rounded-lg bg-slate-50 p-2">
                  <span className="font-medium text-slate-800">{d.source_name ?? 'job'}</span> ·{' '}
                  {fmt.ago(d.created_on)}
                  <code className="mt-1 block break-all text-slate-600">
                    {JSON.stringify(d.source_output ?? d.data).slice(0, 300)}
                  </code>
                  <span className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={dead.isPending}
                      onClick={() => dead.mutate({ id: d.id, action: 'retry' })}
                    >
                      Retry
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        confirm('Discard this failed job? It will not run.') &&
                        dead.mutate({ id: d.id, action: 'discard' })
                      }
                    >
                      Discard
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}
