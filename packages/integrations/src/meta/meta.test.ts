import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ChannelError } from '../channel.ts';
import { buildMessageBody, createMetaCloudChannel } from './cloud-channel.ts';
import { fetchMetaLead } from './lead-ads.ts';
import { metaVerificationChallenge, parseMetaWebhook, verifyMetaSignature } from './webhook.ts';

// Shapes taken from Meta's published OpenAPI examples (facebook/openapi, v23.0).
const envelope = (value: object, field = 'messages') => ({
  object: 'whatsapp_business_account',
  entry: [
    { id: '102290129340398', changes: [{ value: { messaging_product: 'whatsapp', ...value }, field }] },
  ],
});
const metadata = { display_phone_number: '15550783881', phone_number_id: '106540352242922' };
const contacts = [{ profile: { name: 'Sheena Nelson' }, wa_id: '919876543210' }];

describe('webhook signature', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'हाँ' }));
  const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;

  test('accepts the right secret over the raw body only', () => {
    expect(verifyMetaSignature(body, sig, 'app-secret')).toBe(true);
    expect(verifyMetaSignature(body, sig, 'other-secret')).toBe(false);
    expect(verifyMetaSignature(Buffer.from(JSON.stringify({ hello: 'hi' })), sig, 'app-secret')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 'app-secret')).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=abc', 'app-secret')).toBe(false);
  });

  test('verification handshake', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1158201444' };
    expect(metaVerificationChallenge(q, 'tok')).toBe('1158201444');
    expect(metaVerificationChallenge(q, 'wrong')).toBeNull();
  });
});

describe('webhook parsing', () => {
  test('click-to-WhatsApp text message keeps the ad referral', () => {
    const [e] = parseMetaWebhook(
      envelope({
        metadata,
        contacts,
        messages: [
          {
            referral: {
              source_url: 'https://fb.me/3cr4Wqqkv',
              source_id: '1202',
              source_type: 'ad',
              headline: 'Chat with us',
              ctwa_clid: 'Aff-n8',
            },
            from: '919876543210',
            id: 'wamid.A',
            timestamp: '1750275992',
            text: { body: 'Hello! Can I get more info on this?' },
            type: 'text',
          },
        ],
      }),
    );
    expect(e).toEqual({
      type: 'message',
      phoneNumberId: '106540352242922',
      from: '+919876543210',
      providerMessageId: 'wamid.A',
      timestamp: new Date(1750275992 * 1000),
      profileName: 'Sheena Nelson',
      text: 'Hello! Can I get more info on this?',
      buttonPayload: undefined,
      referral: {
        sourceType: 'ad',
        sourceId: '1202',
        sourceUrl: 'https://fb.me/3cr4Wqqkv',
        headline: 'Chat with us',
        ctwaClid: 'Aff-n8',
      },
    });
  });

  test('media: photo caption becomes the text; voice notes and stickers keep their type', () => {
    const events = parseMetaWebhook(
      envelope({
        metadata,
        contacts,
        messages: [
          {
            from: '919876543210',
            id: 'wamid.P',
            timestamp: '1750275992',
            type: 'image',
            image: { id: 'media1', mime_type: 'image/jpeg', caption: 'is this decay?' },
          },
          {
            from: '919876543210',
            id: 'wamid.V',
            timestamp: '1750275993',
            type: 'audio',
            audio: { id: 'media2', voice: true },
          },
          {
            from: '919876543210',
            id: 'wamid.S',
            timestamp: '1750275994',
            type: 'sticker',
            sticker: { id: 'm3' },
          },
        ],
      }),
    );
    expect(events.map((e) => (e.type === 'message' ? [e.mediaType, e.text] : null))).toEqual([
      ['image', 'is this decay?'],
      ['audio', '[audio]'],
      ['sticker', '[sticker]'],
    ]);
  });

  test('template quick-reply and interactive button replies carry their payload', () => {
    const events = parseMetaWebhook(
      envelope({
        metadata,
        contacts,
        messages: [
          {
            from: '919876543210',
            id: 'wamid.B',
            timestamp: '1750091045',
            type: 'button',
            button: { payload: 'reminder_24h:confirm', text: 'Confirm' },
          },
          {
            from: '919876543210',
            id: 'wamid.C',
            timestamp: '1750025136',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'slot:2', title: 'Tue 11:30' } },
          },
          { from: '919876543210', id: 'wamid.D', timestamp: '1750025136', type: 'image', image: { id: 'x' } },
        ],
      }),
    );
    expect(events.map((e) => e.type === 'message' && [e.text, e.buttonPayload])).toEqual([
      ['Confirm', 'reminder_24h:confirm'],
      ['Tue 11:30', 'slot:2'],
      ['[image]', undefined],
    ]);
  });

  test('status updates with pricing and errors', () => {
    const events = parseMetaWebhook(
      envelope({
        metadata,
        statuses: [
          {
            id: 'wamid.X',
            status: 'delivered',
            timestamp: '1750263773',
            recipient_id: '919876543210',
            pricing: { billable: true, pricing_model: 'PMP', category: 'utility' },
          },
          {
            id: 'wamid.Y',
            status: 'failed',
            timestamp: '1750263773',
            recipient_id: '919876543210',
            errors: [{ code: 131047, title: 'Re-engagement message' }],
          },
        ],
      }),
    );
    expect(events).toMatchObject([
      {
        type: 'status',
        providerMessageId: 'wamid.X',
        status: 'delivered',
        pricingCategory: 'utility',
        billable: true,
      },
      { type: 'status', providerMessageId: 'wamid.Y', status: 'failed', errors: [{ code: 131047 }] },
    ]);
  });

  test('Lead Ads leadgen change', () => {
    const events = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: '153125381133',
          changes: [
            {
              field: 'leadgen',
              value: {
                leadgen_id: 444444444444,
                page_id: 153125381133,
                form_id: 7777,
                created_time: 1440120384,
              },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      { type: 'leadgen', pageId: '153125381133', leadgenId: '444444444444', formId: '7777' },
    ]);
  });

  test('malformed envelopes throw; unknown fields are ignored', () => {
    expect(() => parseMetaWebhook({ nope: true })).toThrow();
    expect(parseMetaWebhook(envelope({ metadata }, 'account_update'))).toEqual([]);
  });
});

describe('cloud API channel', () => {
  test('template body: positional body params and one quick-reply payload per button', () => {
    expect(
      buildMessageBody('+919876543210', {
        kind: 'template',
        name: 'il_first_reply',
        language: 'hi',
        bodyParams: ['Priya', 'Smile Dental', 'Asha'],
        buttonPayloads: ['first_reply:yes', 'first_reply:stop'],
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'il_first_reply',
        language: { code: 'hi' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Priya' },
              { type: 'text', text: 'Smile Dental' },
              { type: 'text', text: 'Asha' },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: 'first_reply:yes' }],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '1',
            parameters: [{ type: 'payload', payload: 'first_reply:stop' }],
          },
        ],
      },
    });
  });

  const reply = (status: number, body: object) =>
    Object.assign(async () => new Response(JSON.stringify(body), { status }), {}) as unknown as typeof fetch;

  test('returns the wamid and classifies errors', async () => {
    const ok = createMetaCloudChannel({
      accessToken: 't',
      phoneNumberId: '1',
      fetch: reply(200, { messages: [{ id: 'wamid.OK' }] }),
    });
    expect(await ok.send('+919876543210', { kind: 'text', body: 'hi' })).toEqual({
      providerMessageId: 'wamid.OK',
    });

    const windowClosed = createMetaCloudChannel({
      accessToken: 't',
      phoneNumberId: '1',
      fetch: reply(400, { error: { code: 131047, message: 'Re-engagement message' } }),
    });
    await expect(windowClosed.send('+919876543210', { kind: 'text', body: 'hi' })).rejects.toMatchObject({
      code: 131047,
      retryable: false,
    });

    const down = createMetaCloudChannel({ accessToken: 't', phoneNumberId: '1', fetch: reply(503, {}) });
    const err = await down.send('+919876543210', { kind: 'text', body: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err).toMatchObject({ retryable: true });
  });
});

describe('lead ads', () => {
  test('maps field_data to phone, name, email', async () => {
    let calledUrl = '';
    const fakeFetch = (async (url: URL) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({
          created_time: '2026-10-05T10:00:00+0000',
          form_id: '7777',
          field_data: [
            { name: 'first_name', values: ['Priya'] },
            { name: 'last_name', values: ['Sharma'] },
            { name: 'phone_number', values: ['+919876543210'] },
            { name: 'EMAIL', values: ['priya@example.com'] },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const lead = await fetchMetaLead({ leadgenId: '444', pageAccessToken: 'p', fetch: fakeFetch });
    expect(calledUrl).toContain('/v23.0/444?fields=field_data');
    expect(lead).toMatchObject({
      phone: '+919876543210',
      name: 'Priya Sharma',
      email: 'priya@example.com',
      formId: '7777',
    });
  });
});

describe('template and preference webhooks', () => {
  const envelope = (id: string, field: string, value: object) => ({
    object: 'whatsapp_business_account',
    entry: [{ id, changes: [{ field, value }] }],
  });

  test('template status and category updates carry the WABA id', () => {
    expect(
      parseMetaWebhook(
        envelope('555', 'message_template_status_update', {
          event: 'PAUSED',
          message_template_id: 1,
          message_template_name: 'il_first_reply',
          message_template_language: 'en_US',
          reason: 'Low quality',
          message_template_category: 'UTILITY',
        }),
      ),
    ).toEqual([
      {
        type: 'template_status',
        wabaId: '555',
        event: 'PAUSED',
        name: 'il_first_reply',
        language: 'en_US',
        reason: 'Low quality',
        category: 'UTILITY',
      },
    ]);
    expect(
      parseMetaWebhook(
        envelope('555', 'message_template_category_update', {
          message_template_name: 'il_followup_day2',
          message_template_language: 'en',
          new_category: 'MARKETING',
          previous_category: 'UTILITY',
        }),
      ),
    ).toEqual([
      {
        type: 'template_category',
        wabaId: '555',
        name: 'il_followup_day2',
        language: 'en',
        newCategory: 'MARKETING',
      },
    ]);
  });

  test('user_preferences (stop / resume marketing) becomes an event with the customer E.164 number', () => {
    expect(
      parseMetaWebhook(
        envelope('555', 'user_preferences', {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
          contacts: [{ wa_id: '919876543210' }],
          user_preferences: [
            {
              wa_id: '919876543210',
              detail: 'User requested to stop marketing messages',
              category: 'marketing_messages',
              value: 'stop',
              timestamp: 1731705721,
            },
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'user_preference',
        phoneNumberId: '106540352242922',
        from: '+919876543210',
        category: 'marketing_messages',
        value: 'stop',
      },
    ]);
  });

  test('a template event without an entry id is ignored, not an error', () => {
    expect(
      parseMetaWebhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'message_template_status_update',
                value: { event: 'APPROVED', message_template_name: 'x', message_template_language: 'en' },
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});
