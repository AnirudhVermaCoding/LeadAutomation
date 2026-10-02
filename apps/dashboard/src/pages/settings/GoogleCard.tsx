import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { useLocation } from '../../router.ts';
import { Badge, Button, Card, ErrorState, Field, fmt, Input, Loading, Select } from '../../ui.tsx';

export interface GoogleState {
  available: boolean;
  mock: boolean;
  connected: boolean;
  status: 'ok' | 'reauth_needed' | null;
  last_error: string | null;
  can_list_calendars: boolean;
  resources: string[];
  links: {
    id: string;
    calendar_id: string;
    label: string | null;
    resource: string | null;
    read_busy: boolean;
    write_bookings: boolean;
    last_synced_at: string | null;
    last_error: string | null;
    push: boolean;
    blocked_events: number;
  }[];
}

interface Row {
  calendar_id: string;
  label: string;
  resource: string | null;
  read_busy: boolean;
  write_bookings: boolean;
}

export const googleKey = ['google'] as const;

const toRows = (links: GoogleState['links']): Row[] =>
  links.map((l) => ({
    calendar_id: l.calendar_id,
    label: l.label ?? '',
    resource: l.resource,
    read_busy: l.read_busy,
    write_bookings: l.write_bookings,
  }));

/** Connect Google, then say which calendar belongs to which doctor / agent (or the whole clinic). */
export function GoogleCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { search } = useLocation();
  const result = new URLSearchParams(search).get('google');
  const q = useQuery({
    queryKey: googleKey,
    queryFn: () => api<GoogleState>('/v1/integrations/google'),
    refetchInterval: 30_000,
  });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [adding, setAdding] = useState('');
  useEffect(() => {
    if (q.data && rows === null) setRows(toRows(q.data.links));
  }, [q.data, rows]);
  // Refetch first, then rebuild the editable rows from the fresh data (not the stale cache).
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: googleKey });
    setRows(null);
  };
  const connect = useMutation({
    mutationFn: async () => {
      if (q.data?.mock) {
        await api('/v1/dev/google/connect', { method: 'POST', body: {} });
        return null;
      }
      return api<{ url: string }>('/v1/integrations/google/start');
    },
    onSuccess: (r) => (r ? window.location.assign(r.url) : refresh()),
  });
  const picker = useQuery({
    queryKey: ['google-calendars'],
    queryFn: () =>
      api<{ items: { id: string; summary: string; primary: boolean }[] }>(
        '/v1/integrations/google/calendars',
      ),
    enabled: Boolean(q.data?.connected && q.data.can_list_calendars && canEdit),
  });
  const save = useMutation({
    mutationFn: () =>
      api('/v1/integrations/google/links', {
        method: 'PUT',
        body: (rows ?? []).map((r) => ({ ...r, label: r.label || undefined })),
      }),
    onSuccess: refresh,
  });
  const sync = useMutation({
    mutationFn: () => api('/v1/integrations/google/sync', { method: 'POST', body: {} }),
    onSuccess: () => setTimeout(() => void refresh(), 1500),
  });
  const disconnect = useMutation({
    mutationFn: () => api('/v1/integrations/google/disconnect', { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const g = q.data;
  const edit = (i: number, patch: Partial<Row>) =>
    setRows((rows ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (id: string, label = '') => {
    const calendar_id = id.trim();
    if (!calendar_id || rows?.some((r) => r.calendar_id === calendar_id)) return;
    setRows([...(rows ?? []), { calendar_id, label, resource: null, read_busy: true, write_bookings: true }]);
    setAdding('');
  };
  const dirty = JSON.stringify(rows) !== JSON.stringify(toRows(g.links));

  return (
    <Card
      title="Google Calendar (optional)"
      actions={
        g.connected &&
        (g.status === 'reauth_needed' ? (
          <Badge tone="bg-red-50 text-red-700 ring-red-200">Reconnect needed</Badge>
        ) : (
          <Badge tone="bg-emerald-50 text-emerald-700 ring-emerald-200">Connected</Badge>
        ))
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Bookings are copied to your Google Calendar, and anything your team adds there (leave, meetings,
        bookings made by phone) stops those times from being offered. Event titles are never read.
      </p>
      {result === 'connected' && <p className="mb-3 text-sm text-brand-700">Google Calendar connected.</p>}
      {result && result !== 'connected' && (
        <p className="mb-3 text-sm text-red-700">
          Google Calendar was not connected ({result.replaceAll('_', ' ')}).
        </p>
      )}
      {!g.available && (
        <p className="text-sm text-slate-500">
          Google Calendar is not set up for this account yet. Ask your provider.
        </p>
      )}

      {g.available && (!g.connected || g.status === 'reauth_needed') && canEdit && (
        <div className="space-y-2">
          {g.status === 'reauth_needed' && (
            <p className="text-sm text-red-700">
              Google stopped giving us access (it was revoked or expired), so bookings are not syncing.
              Reconnect to fix it.
            </p>
          )}
          <Button
            size="sm"
            variant={g.connected ? 'primary' : 'secondary'}
            loading={connect.isPending}
            onClick={() => connect.mutate()}
          >
            {g.connected
              ? 'Reconnect Google'
              : g.mock
                ? 'Connect Google Calendar (demo)'
                : 'Connect Google Calendar'}
          </Button>
        </div>
      )}
      {connect.error && <p className="mt-2 text-sm text-red-700">{connect.error.message}</p>}

      {g.connected && rows && (
        <div className="mt-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Calendars</h3>
          {rows.length === 0 && <p className="text-sm text-slate-500">No calendar linked yet.</p>}
          {rows.map((r, i) => {
            const live = g.links.find((l) => l.calendar_id === r.calendar_id);
            return (
              <div key={r.calendar_id} className="rounded-lg border border-slate-100 p-3 text-sm">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-48 flex-1">
                    <p className="font-medium text-slate-800">
                      {r.label || (r.calendar_id === 'primary' ? 'Primary calendar' : r.calendar_id)}
                    </p>
                    <p className="text-xs text-slate-500">{r.calendar_id}</p>
                  </div>
                  <Field label="Belongs to">
                    <Select
                      value={r.resource ?? ''}
                      disabled={!canEdit}
                      onChange={(e) => edit(i, { resource: e.target.value || null })}
                    >
                      <option value="">Whole clinic (blocks everyone)</option>
                      {g.resources.map((x) => (
                        <option key={x} value={x}>
                          {x === 'default' ? 'Main calendar' : x}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <label className="flex items-center gap-1.5 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={r.read_busy}
                      onChange={(e) => edit(i, { read_busy: e.target.checked })}
                    />
                    Its events block slots
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={r.write_bookings}
                      onChange={(e) => edit(i, { write_bookings: e.target.checked })}
                    />
                    Add our bookings
                  </label>
                  {canEdit && (
                    <Button variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  )}
                </div>
                {live && (
                  <p className="mt-2 text-xs text-slate-500">
                    {live.last_synced_at
                      ? `Last checked ${fmt.dateTime(live.last_synced_at)}`
                      : 'Not checked yet'}{' '}
                    · {live.push ? 'live updates on' : 'checked every few minutes'} · {live.blocked_events}{' '}
                    blocking event{live.blocked_events === 1 ? '' : 's'}
                    {live.last_error && <span className="text-red-700"> · {live.last_error}</span>}
                  </p>
                )}
              </div>
            );
          })}
          {canEdit && (
            <div className="flex flex-wrap items-end gap-2">
              {g.can_list_calendars && picker.data ? (
                <Field label="Add a calendar">
                  <Select
                    value=""
                    onChange={(e) =>
                      add(e.target.value, picker.data.items.find((c) => c.id === e.target.value)?.summary)
                    }
                  >
                    <option value="">Choose…</option>
                    {picker.data.items
                      .filter((c) => !rows.some((r) => r.calendar_id === c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.summary}
                        </option>
                      ))}
                  </Select>
                </Field>
              ) : (
                <>
                  <Field
                    label="Add a calendar by its ID (the calendar's email address)"
                    hint="Reconnect Google to get a picker."
                  >
                    <Input
                      value={adding}
                      onChange={(e) => setAdding(e.target.value)}
                      placeholder="dr.rao@yourclinic.com"
                    />
                  </Field>
                  <Button size="sm" variant="secondary" disabled={!adding.trim()} onClick={() => add(adding)}>
                    Add
                  </Button>
                </>
              )}
            </div>
          )}
          {canEdit && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
                Save calendars
              </Button>
              <Button size="sm" variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()}>
                Sync now
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  confirm(
                    'Disconnect Google? Busy time from Google is forgotten and bookings stop syncing. Events already in your calendar stay.',
                  ) && disconnect.mutate()
                }
              >
                Disconnect
              </Button>
            </div>
          )}
          {save.error && <p className="text-sm text-red-700">{save.error.message}</p>}
        </div>
      )}
    </Card>
  );
}
