import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type { LeadState } from './api.ts';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-brand-700/50',
  secondary: 'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
  danger: 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-xs', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-slate-50';

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={cx(inputClass, props.className)} />
);
export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={cx(inputClass, 'min-h-20', props.className)} />
);
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={cx(inputClass, props.className)} />
);

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const STATE_STYLE: Partial<Record<LeadState | 'human_takeover', string>> = {
  new: 'bg-sky-50 text-sky-700 ring-sky-200',
  contacted: 'bg-sky-50 text-sky-700 ring-sky-200',
  qualifying: 'bg-amber-50 text-amber-800 ring-amber-200',
  qualified: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  booking_offered: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  booked: 'bg-brand-50 text-brand-700 ring-brand-100',
  confirmed: 'bg-brand-50 text-brand-700 ring-brand-100',
  completed: 'bg-slate-100 text-slate-700 ring-slate-200',
  no_show: 'bg-orange-50 text-orange-700 ring-orange-200',
  disqualified: 'bg-slate-100 text-slate-500 ring-slate-200',
  unresponsive: 'bg-slate-100 text-slate-500 ring-slate-200',
  nurturing: 'bg-violet-50 text-violet-700 ring-violet-200',
  opted_out: 'bg-red-50 text-red-700 ring-red-200',
  human_takeover: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200',
};

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        tone ?? 'bg-slate-100 text-slate-700 ring-slate-200',
      )}
    >
      {children}
    </span>
  );
}

export const StateBadge = ({ state, aiPaused }: { state: LeadState; aiPaused?: boolean }) =>
  aiPaused && state !== 'opted_out' ? (
    <Badge tone={STATE_STYLE.human_takeover}>human takeover</Badge>
  ) : (
    <Badge tone={STATE_STYLE[state]}>{state.replaceAll('_', ' ')}</Badge>
  );

const TIER_STYLE = {
  hot: 'bg-red-50 text-red-700 ring-red-200',
  warm: 'bg-amber-50 text-amber-800 ring-amber-200',
  cold: 'bg-slate-100 text-slate-600 ring-slate-200',
};
export const TierBadge = ({ tier }: { tier: 'hot' | 'warm' | 'cold' | null }) =>
  tier ? <Badge tone={TIER_STYLE[tier]}>{tier}</Badge> : null;

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-500" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-2">
        <p>{error instanceof Error ? error.message : 'Something went wrong.'}</p>
        {retry && (
          <Button variant="secondary" size="sm" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      <Inbox className="size-6 text-slate-400" aria-hidden />
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children && <div className="text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export const fmt = {
  time: (iso: string, tz?: string) =>
    new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(
      new Date(iso),
    ),
  dateTime: (iso: string, tz?: string) =>
    new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    }).format(new Date(iso)),
  day: (iso: string, tz?: string) =>
    new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(
      new Date(iso),
    ),
  ago: (iso: string) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  },
  inr: (n: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(
      n,
    ),
};

export { cx };
