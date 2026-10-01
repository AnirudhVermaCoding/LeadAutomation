import { CheckCheck, Clock, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Message } from '../api.ts';
import { cx, fmt } from '../ui.tsx';

/** WhatsApp-style message list (inbox and demo sandbox). Optional tappable quick replies. */
export function Thread({
  messages,
  tz,
  onButton,
  className,
}: {
  messages: Message[];
  tz: string;
  onButton?: (payload: string, title: string) => void;
  className?: string;
}) {
  const end = useRef<HTMLDivElement>(null);
  // Block body: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  if (!messages.length) return <p className="py-8 text-center text-sm text-slate-400">No messages yet.</p>;
  const lastOut = messages.findLastIndex((m) => m.direction === 'out');

  return (
    <div className={cx('max-h-[28rem] space-y-2 overflow-y-auto rounded-lg bg-[#efeae2] p-3', className)}>
      {messages.map((m, i) => {
        const out = m.direction === 'out';
        const buttons = out ? (m.payload?.buttons ?? []) : [];
        return (
          <div key={m.id} className={cx('flex flex-col', out ? 'items-end' : 'items-start')}>
            <div
              className={cx(
                'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm shadow-xs',
                out
                  ? 'rounded-tr-none bg-[#d9fdd3] text-slate-900'
                  : 'rounded-tl-none bg-white text-slate-900',
                m.status === 'failed' && 'ring-1 ring-red-300',
              )}
            >
              {m.templateKey && (
                <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  template · {m.templateKey.replaceAll('_', ' ')}
                </span>
              )}
              {m.kind === 'button_reply' && (
                <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  tapped button
                </span>
              )}
              {m.body}
              <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-500">
                {fmt.time(m.occurredAt, tz)}
                {out && m.status === 'queued' && <Clock className="size-3" aria-label="queued" />}
                {out && ['sent', 'delivered', 'read'].includes(m.status) && (
                  <CheckCheck
                    className={cx('size-3', m.status === 'read' && 'text-sky-500')}
                    aria-label={m.status}
                  />
                )}
                {m.status === 'failed' && (
                  <TriangleAlert className="size-3 text-red-600" aria-label="failed" />
                )}
              </span>
              {m.status === 'failed' && m.error && (
                <span className="block text-[11px] text-red-700">{m.error.message}</span>
              )}
            </div>
            {buttons.length > 0 && (
              <div className="mt-1 flex max-w-[85%] flex-wrap justify-end gap-1">
                {buttons.map((b) => (
                  <button
                    key={b.id}
                    disabled={!onButton || i !== lastOut}
                    onClick={() => onButton?.(b.id, b.title)}
                    className="rounded-full bg-white px-3 py-1 text-xs font-medium text-sky-700 shadow-xs enabled:hover:bg-sky-50 disabled:text-slate-400"
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
