import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * What the business logic sees of a phone call, whatever the vendor. The vendor runs the telephony,
 * speech and conversation; every action that changes clinic data comes back to us as a tool call
 * and runs through the same validated tool boundary as WhatsApp.
 */
export type VoiceEvent =
  | { type: 'call_started'; callId: string; from: string | null }
  | {
      type: 'tool_calls';
      callId: string;
      from: string | null;
      calls: { id: string; name: string; args: unknown }[];
    }
  /** A caller utterance (final transcripts only): emergency phrases are checked on it, deterministically. */
  | { type: 'transcript'; callId: string; from: string | null; text: string }
  /** The vendor asks where to transfer the caller to reach a person. */
  | { type: 'transfer_request'; callId: string; from: string | null }
  | {
      type: 'call_ended';
      callId: string;
      from: string | null;
      endedReason: string | null;
      summary: string | null;
      durationSec: number | null;
      transferred: boolean;
      failed: boolean;
    }
  | { type: 'ignored'; reason: string };

export interface VoiceProvider {
  readonly name: 'vapi';
  /** True when the request carries the clinic's shared secret. */
  authenticate(headers: Record<string, string | string[] | undefined>, secret: string): boolean;
  parse(body: unknown): VoiceEvent;
  /** HTTP body answering a tool_calls event. */
  toolResponse(results: { id: string; name: string; result: string }[]): unknown;
  /** HTTP body answering a transfer_request: a number, or a refusal the vendor reads out. */
  transferResponse(to: { number: string; message: string } | { error: string }): unknown;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const VapiMessage = z.looseObject({
  message: z.looseObject({
    type: z.string(),
    call: z
      .looseObject({
        id: z.string().optional(),
        customer: z.looseObject({ number: z.string().optional() }).optional(),
        analysis: z.looseObject({ summary: z.string().optional() }).optional(),
      })
      .optional(),
    customer: z.looseObject({ number: z.string().optional() }).optional(),
    toolCallList: z
      .array(
        z.looseObject({
          id: z.string(),
          name: z.string().optional(),
          parameters: z.unknown().optional(),
          function: z.looseObject({ name: z.string(), arguments: z.unknown().optional() }).optional(),
        }),
      )
      .optional(),
    status: z.string().optional(),
    role: z.string().optional(),
    transcriptType: z.string().optional(),
    transcript: z.string().optional(),
    endedReason: z.string().optional(),
    summary: z.string().optional(),
    analysis: z.looseObject({ summary: z.string().optional() }).optional(),
    durationSeconds: z.number().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
  }),
});

/** Function arguments may arrive as an object or a JSON string (OpenAI-style tool calls). */
const argsOf = (raw: unknown) => {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

/**
 * Vapi server-URL messages (docs.vapi.ai/server-url/events): `tool-calls`, `status-update`,
 * `transcript`, `transfer-destination-request`, `end-of-call-report`. Authentication is the
 * credential Vapi sends with each request: `Authorization: Bearer <secret>` (or the legacy
 * `X-Vapi-Secret: <secret>`), compared in constant time.
 */
export const vapiProvider: VoiceProvider = {
  name: 'vapi',
  authenticate(headers, secret) {
    const auth = headers.authorization;
    const legacy = headers['x-vapi-secret'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    return (bearer !== null && same(bearer, secret)) || (typeof legacy === 'string' && same(legacy, secret));
  },
  parse(body) {
    const parsed = VapiMessage.safeParse(body);
    if (!parsed.success) return { type: 'ignored', reason: 'not a Vapi server message' };
    const m = parsed.data.message;
    const callId = m.call?.id;
    if (!callId) return { type: 'ignored', reason: 'no call id' };
    const from = m.call?.customer?.number ?? m.customer?.number ?? null;
    switch (m.type) {
      case 'status-update':
        return m.status === 'in-progress'
          ? { type: 'call_started', callId, from }
          : { type: 'ignored', reason: `status ${m.status}` };
      case 'tool-calls':
        return {
          type: 'tool_calls',
          callId,
          from,
          calls: (m.toolCallList ?? []).map((c) => ({
            id: c.id,
            name: c.name ?? c.function?.name ?? '',
            args: argsOf(c.parameters ?? c.function?.arguments),
          })),
        };
      case 'transcript':
        return m.role === 'user' && m.transcriptType === 'final' && m.transcript
          ? { type: 'transcript', callId, from, text: m.transcript }
          : { type: 'ignored', reason: 'partial or assistant transcript' };
      case 'transfer-destination-request':
        return { type: 'transfer_request', callId, from };
      case 'end-of-call-report': {
        const reason = m.endedReason ?? null;
        const started = m.startedAt ? Date.parse(m.startedAt) : NaN;
        const ended = m.endedAt ? Date.parse(m.endedAt) : NaN;
        const duration =
          m.durationSeconds ??
          (Number.isFinite(started) && Number.isFinite(ended) ? (ended - started) / 1000 : null);
        return {
          type: 'call_ended',
          callId,
          from,
          endedReason: reason,
          summary: m.analysis?.summary ?? m.summary ?? m.call?.analysis?.summary ?? null,
          durationSec: duration === null ? null : Math.max(0, Math.round(duration)),
          transferred: /forward|transfer/i.test(reason ?? ''),
          failed: /error|failed|fault/i.test(reason ?? ''),
        };
      }
      default:
        return { type: 'ignored', reason: `message ${m.type}` };
    }
  },
  toolResponse: (results) => ({
    results: results.map((r) => ({ name: r.name, toolCallId: r.id, result: r.result })),
  }),
  transferResponse: (to) =>
    'error' in to
      ? { error: to.error }
      : {
          destination: { type: 'number', number: to.number },
          message: { type: 'request-start', message: to.message },
        },
};

export const VOICE_PROVIDERS = { vapi: vapiProvider } as const satisfies Record<string, VoiceProvider>;
