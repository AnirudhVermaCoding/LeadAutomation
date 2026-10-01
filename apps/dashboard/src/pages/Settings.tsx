import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Download, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, type Role, type TenantConfig } from '../api.ts';
import { useLocation } from '../router.ts';
import { Button, Card, cx, PageHeader } from '../ui.tsx';
import { Integrations } from './settings/Integrations.tsx';
import { Availability, Templates } from './settings/Operations.tsx';
import {
  BookingSection,
  BusinessSection,
  KnowledgeSection,
  MessagesSection,
  QualificationSection,
  ReportsSection,
} from './settings/Sections.tsx';

export type Edit = (fn: (draft: TenantConfig) => void) => void;

const TABS = [
  ['business', 'Business'],
  ['qualification', 'Questions'],
  ['knowledge', 'Knowledge'],
  ['booking', 'Booking'],
  ['messages', 'Messages'],
  ['reports', 'Reports'],
  ['integrations', 'Integrations'],
] as const;
type Tab = (typeof TABS)[number][0];

export function SettingsPage({
  config,
  revision,
  role,
}: {
  config: TenantConfig;
  revision: number;
  role: Role;
}) {
  const qc = useQueryClient();
  const { search } = useLocation();
  const canEdit = role !== 'client_staff';
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(search).get('google') ? 'integrations' : 'business',
  );
  const [draft, setDraft] = useState(config);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    setDraft(config);
  }, [config]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  const edit: Edit = (fn) =>
    setDraft((d) => {
      const next = structuredClone(d);
      fn(next);
      return next;
    });

  const save = useMutation({
    mutationFn: (body: unknown) => api<{ revision: number }>('/v1/config', { method: 'PUT', body }),
    onSuccess: async () => {
      setErrors([]);
      await qc.invalidateQueries({ queryKey: ['config'] });
      await qc.invalidateQueries({ queryKey: ['onboarding'] });
    },
    onError: (err) =>
      setErrors(
        err instanceof ApiError && Array.isArray(err.body.errors)
          ? (err.body.errors as string[])
          : [err.message],
      ),
  });

  const exportJson = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
    );
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `instantlead-config-r${revision}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = async (file: File) => {
    try {
      save.mutate(JSON.parse(await file.text()));
    } catch {
      setErrors(['That file is not valid JSON.']);
    }
  };

  return (
    <div className="pb-24">
      <PageHeader
        title="Settings"
        subtitle={`Configuration revision ${revision}${canEdit ? '' : ' · view only'}`}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={exportJson}>
              <Download className="size-3.5" aria-hidden /> Export JSON
            </Button>
            {canEdit && (
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50">
                <Upload className="size-3.5" aria-hidden /> Import JSON
                <input
                  type="file"
                  accept="application/json"
                  className="sr-only"
                  onChange={(e) => e.target.files?.[0] && void importJson(e.target.files[0])}
                />
              </label>
            )}
          </div>
        }
      />
      <Onboarding />

      <div
        className="mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-slate-200"
        role="tablist"
      >
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cx(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              tab === key
                ? 'border-brand-700 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <fieldset disabled={!canEdit} className="space-y-4">
        {tab === 'business' && <BusinessSection draft={draft} edit={edit} />}
        {tab === 'qualification' && <QualificationSection draft={draft} edit={edit} />}
        {tab === 'knowledge' && <KnowledgeSection draft={draft} edit={edit} />}
        {tab === 'booking' && (
          <>
            <BookingSection draft={draft} edit={edit} />
            <Availability canEdit={canEdit} />
          </>
        )}
        {tab === 'messages' && (
          <>
            <MessagesSection draft={draft} edit={edit} />
            <Templates canEdit={canEdit} />
          </>
        )}
        {tab === 'reports' && <ReportsSection draft={draft} edit={edit} />}
        {tab === 'integrations' && <Integrations canEdit={canEdit} />}
      </fieldset>

      {(dirty || errors.length > 0) && canEdit && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur md:left-60">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              {errors.length ? (
                <ul className="max-h-28 list-disc space-y-0.5 overflow-y-auto pl-5 text-red-700" role="alert">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              ) : (
                <span className="text-slate-600">You have unsaved changes.</span>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft(config);
                  setErrors([]);
                }}
              >
                Discard
              </Button>
              <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(draft)}>
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Onboarding() {
  const q = useQuery({
    queryKey: ['onboarding'],
    queryFn: () =>
      api<{ steps: { key: string; label: string; done: boolean }[]; done: number; total: number }>(
        '/v1/onboarding',
      ),
  });
  if (!q.data || q.data.done === q.data.total) return null;
  return (
    <Card title={`Go-live checklist · ${q.data.done}/${q.data.total}`} className="mb-6">
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-brand-600"
          style={{ width: `${(q.data.done / q.data.total) * 100}%` }}
        />
      </div>
      <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
        {q.data.steps.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            {s.done ? (
              <CheckCircle2 className="size-4 text-brand-600" aria-label="done" />
            ) : (
              <Circle className="size-4 text-slate-300" aria-label="to do" />
            )}
            <span className={s.done ? 'text-slate-500' : 'text-slate-800'}>{s.label}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
