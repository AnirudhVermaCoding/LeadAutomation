import { ChannelError } from './channel.ts';

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Resend dedupes requests with the same key for 24 h. */
  idempotencyKey?: string;
}

export interface EmailProvider {
  readonly provider: 'fake' | 'resend';
  send(message: EmailMessage): Promise<{ id: string }>;
}

/** Resend (https://resend.com/docs/api-reference/emails/send-email). */
export function createResendEmail(opts: {
  apiKey: string;
  from: string;
  fetch?: typeof globalThis.fetch;
}): EmailProvider {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    provider: 'resend',
    async send(m) {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          ...(m.idempotencyKey ? { 'idempotency-key': m.idempotencyKey } : {}),
        },
        body: JSON.stringify({ from: opts.from, to: m.to, subject: m.subject, text: m.text, html: m.html }),
        signal: AbortSignal.timeout(15_000),
      }).catch((err: unknown) => {
        throw new ChannelError(`Email request failed: ${String(err)}`, { retryable: true });
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok && json.id) return { id: json.id };
      throw new ChannelError(`Email error (HTTP ${res.status}): ${json.message ?? 'unknown'}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    },
  };
}

export function createFakeEmail() {
  const sent: (EmailMessage & { id: string })[] = [];
  const email: EmailProvider & { sent: typeof sent } = {
    provider: 'fake',
    sent,
    send(m) {
      const id = `fake-email-${sent.length + 1}`;
      sent.push({ ...m, id });
      return Promise.resolve({ id });
    },
  };
  return email;
}
