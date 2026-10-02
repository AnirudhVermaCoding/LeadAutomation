import { randomUUID } from 'node:crypto';

/** What can go out on WhatsApp. Choosing template vs free-form is the caller's job (core `chooseOutbound`). */
export type OutboundContent =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: { id: string; title: string }[] }
  | {
      kind: 'template';
      name: string;
      language: string;
      bodyParams: string[];
      /** One payload per quick-reply button, in button order. */
      buttonPayloads: string[];
    };

export interface MessagingChannel {
  readonly provider: 'fake' | 'meta';
  /** `to` is E.164. Throws ChannelError on failure. */
  send(to: string, content: OutboundContent): Promise<{ providerMessageId: string }>;
  /** Blue ticks on their message plus "typing…" until we reply (max 25 s). Best effort. */
  markRead(providerMessageId: string): Promise<void>;
}

export class ChannelError extends Error {
  readonly code: number | undefined;
  /** Worth retrying later (rate limit, 5xx, network) vs. permanent (bad template, window closed). */
  readonly retryable: boolean;

  constructor(message: string, opts: { code?: number; retryable: boolean }) {
    super(message);
    this.code = opts.code;
    this.retryable = opts.retryable;
  }
}

/** Mock-mode channel: accepts everything, remembers what it sent (the DB is the real record). */
export function createFakeChannel() {
  const sent: { to: string; content: OutboundContent; providerMessageId: string }[] = [];
  const read: string[] = [];
  const channel: MessagingChannel & { sent: typeof sent; read: typeof read } = {
    provider: 'fake',
    sent,
    read,
    markRead(providerMessageId) {
      read.push(providerMessageId);
      return Promise.resolve();
    },
    send(to, content) {
      const providerMessageId = `fake.${randomUUID()}`;
      sent.push({ to, content, providerMessageId });
      return Promise.resolve({ providerMessageId });
    },
  };
  return channel;
}
