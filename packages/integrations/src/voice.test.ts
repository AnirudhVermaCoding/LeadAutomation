import { describe, expect, test } from 'vitest';
import { vapiProvider } from './voice.ts';

const call = { id: 'call_1', customer: { number: '+919876543210' } };

describe('Vapi adapter', () => {
  test('authenticates with the bearer credential or the legacy header, in constant time', () => {
    expect(vapiProvider.authenticate({ authorization: 'Bearer s3cret' }, 's3cret')).toBe(true);
    expect(vapiProvider.authenticate({ 'x-vapi-secret': 's3cret' }, 's3cret')).toBe(true);
    expect(vapiProvider.authenticate({ authorization: 'Bearer nope' }, 's3cret')).toBe(false);
    expect(vapiProvider.authenticate({ authorization: 's3cret' }, 's3cret')).toBe(false);
    expect(vapiProvider.authenticate({}, 's3cret')).toBe(false);
  });

  test('normalizes tool calls (object or JSON-string arguments) and answers in Vapi format', () => {
    const e = vapiProvider.parse({
      message: {
        type: 'tool-calls',
        call,
        toolCallList: [
          { id: 't1', name: 'get_available_slots', parameters: { service: 'Consultation' } },
          { id: 't2', function: { name: 'cancel', arguments: '{"for_name":"me"}' } },
        ],
      },
    });
    expect(e).toEqual({
      type: 'tool_calls',
      callId: 'call_1',
      from: '+919876543210',
      calls: [
        { id: 't1', name: 'get_available_slots', args: { service: 'Consultation' } },
        { id: 't2', name: 'cancel', args: { for_name: 'me' } },
      ],
    });
    expect(vapiProvider.toolResponse([{ id: 't1', name: 'cancel', result: 'ok' }])).toEqual({
      results: [{ name: 'cancel', toolCallId: 't1', result: 'ok' }],
    });
  });

  test('end-of-call report: summary, duration from either field, transfer and failure flags', () => {
    expect(
      vapiProvider.parse({
        message: {
          type: 'end-of-call-report',
          call,
          endedReason: 'assistant-forwarded-call',
          analysis: { summary: 'Booked a cleaning.' },
          startedAt: '2026-10-05T04:30:00Z',
          endedAt: '2026-10-05T04:33:30Z',
        },
      }),
    ).toMatchObject({ type: 'call_ended', summary: 'Booked a cleaning.', durationSec: 210, transferred: true, failed: false });
    expect(
      vapiProvider.parse({ message: { type: 'end-of-call-report', call, endedReason: 'pipeline-error-openai', durationSeconds: 12.4 } }),
    ).toMatchObject({ durationSec: 12, failed: true, summary: null });
  });

  test('final caller transcripts only; unknown or malformed messages are ignored', () => {
    expect(
      vapiProvider.parse({ message: { type: 'transcript', call, role: 'user', transcriptType: 'final', transcript: 'my face is swelling' } }),
    ).toEqual({ type: 'transcript', callId: 'call_1', from: '+919876543210', text: 'my face is swelling' });
    expect(vapiProvider.parse({ message: { type: 'transcript', call, role: 'user', transcriptType: 'partial', transcript: 'my' } }).type).toBe('ignored');
    expect(vapiProvider.parse({ message: { type: 'speech-update', call } }).type).toBe('ignored');
    expect(vapiProvider.parse({ nope: true }).type).toBe('ignored');
    expect(vapiProvider.parse({ message: { type: 'tool-calls' } }).type).toBe('ignored');
  });

  test('transfer answers', () => {
    expect(vapiProvider.transferResponse({ number: '+911234567890', message: 'Connecting you' })).toEqual({
      destination: { type: 'number', number: '+911234567890' },
      message: { type: 'request-start', message: 'Connecting you' },
    });
    expect(vapiProvider.transferResponse({ error: 'closed' })).toEqual({ error: 'closed' });
  });
});
