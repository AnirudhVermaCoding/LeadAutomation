import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  Building2,
  CalendarCheck,
  FlaskConical,
  Inbox,
  LogOut,
  Menu,
  Settings,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, tenantSelection, type Me, type TenantConfig, type TenantRow } from './api.ts';
import { Agency } from './pages/Agency.tsx';
import { InboxPage } from './pages/Inbox.tsx';
import { Login } from './pages/Login.tsx';
import { ReportsPage } from './pages/Reports.tsx';
import { Sandbox } from './pages/Sandbox.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { Today } from './pages/Today.tsx';
import { navigate, useLocation } from './router.ts';
import { Button, cx, ErrorState, Loading, Select } from './ui.tsx';

const NAV = [
  { path: '/', label: 'Today', icon: CalendarCheck },
  { path: '/inbox', label: 'Inbox', icon: Inbox },
  { path: '/reports', label: 'Reports', icon: BarChart3 },
  { path: '/sandbox', label: 'Demo sandbox', icon: FlaskConical },
  { path: '/settings', label: 'Settings', icon: Settings },
] as const;

export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/me') });
  if (me.isPending) return <Loading />;
  if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
  if (me.error)
    return (
      <div className="p-6">
        <ErrorState error={me.error} retry={() => void me.refetch()} />
      </div>
    );
  return <Shell me={me.data} />;
}

function Shell({ me }: { me: Me }) {
  const { path } = useLocation();
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const isAgency = me.principal.role === 'agency_admin';
  const [tenant, setTenant] = useState(() => (isAgency ? tenantSelection.get() : me.principal.tenantId));
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api<TenantRow[]>('/v1/admin/tenants'),
    enabled: isAgency,
  });

  // Agency admins land on a tenant: keep their last choice, or the first one.
  useEffect(() => {
    if (isAgency && !tenant && tenants.data?.[0]) choose(tenants.data[0].id);
  });
  const choose = (id: string) => {
    tenantSelection.set(id);
    setTenant(id);
    void qc.invalidateQueries({ predicate: (q) => !['me', 'tenants'].includes(String(q.queryKey[0])) });
  };
  const config = useQuery({
    queryKey: ['config', tenant],
    queryFn: () => api<{ config: TenantConfig; revision: number }>('/v1/config'),
    enabled: Boolean(tenant),
  });

  const signOut = async () => {
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    tenantSelection.set(null);
    qc.clear();
    await qc.invalidateQueries({ queryKey: ['me'] });
  };

  const nav = [...NAV, ...(isAgency ? [{ path: '/agency', label: 'Agency', icon: Building2 } as const] : [])];
  const page = (() => {
    if (path === '/agency' && isAgency) return <Agency onSwitch={choose} />;
    if (!tenant) return <Loading label="Choose a tenant…" />;
    if (config.error) return <ErrorState error={config.error} retry={() => void config.refetch()} />;
    if (!config.data) return <Loading />;
    const props = { config: config.data.config, role: me.principal.role };
    switch (path) {
      case '/inbox':
        return <InboxPage {...props} />;
      case '/reports':
        return <ReportsPage {...props} />;
      case '/sandbox':
        return <Sandbox {...props} />;
      case '/settings':
        return <SettingsPage {...props} revision={config.data.revision} />;
      default:
        return <Today {...props} />;
    }
  })();

  return (
    <div className="min-h-dvh md:flex">
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-30 w-60 shrink-0 border-r border-slate-200 bg-white p-4 transition-transform md:static md:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="mb-6 flex items-center justify-between">
          <span className="text-base font-semibold tracking-tight text-brand-700">InstantLead</span>
          <button className="md:hidden" onClick={() => setMenuOpen(false)} aria-label="Close menu">
            <X className="size-5" />
          </button>
        </div>
        {isAgency && (
          <div className="mb-5">
            <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor="tenant">
              Tenant
            </label>
            <Select id="tenant" value={tenant ?? ''} onChange={(e) => choose(e.target.value)}>
              {tenants.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <nav className="space-y-1">
          {nav.map(({ path: to, label, icon: Icon }) => (
            <NavLink key={to} to={to} active={path === to} onNavigate={() => setMenuOpen(false)}>
              <Icon className="size-4" aria-hidden /> {label}
            </NavLink>
          ))}
        </nav>
        <Button variant="ghost" className="mt-6 w-full justify-start" onClick={() => void signOut()}>
          <LogOut className="size-4" aria-hidden /> Sign out
        </Button>
      </aside>
      {menuOpen && (
        <div className="fixed inset-0 z-20 bg-slate-900/20 md:hidden" onClick={() => setMenuOpen(false)} />
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-8">
          <button className="md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <span className="truncate text-sm font-medium text-slate-700">
            {config.data?.config.brand.business_name ?? ''}
          </span>
        </header>
        <main className="mx-auto max-w-6xl p-4 md:p-8">{page}</main>
      </div>
    </div>
  );
}

function NavLink({
  to,
  active,
  children,
  onNavigate,
}: {
  to: string;
  active: boolean;
  children: ReactNode;
  onNavigate: () => void;
}) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
        onNavigate();
      }}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium',
        active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
      )}
    >
      {children}
    </a>
  );
}
