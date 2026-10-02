import { describe, expect, test } from 'vitest';
import {
  checkReply,
  cleanReply,
  hasCustomerSignal,
  isEmojiOnly,
  mediaResponse,
  normalizeInbound,
  notALeadReply,
  redact,
  ruleBasedIntent,
  sameReply,
  type ReplyContext,
} from './guard.ts';

describe('inbound', () => {
  test('normalizes: control and zero-width characters, floods, length', () => {
    expect(normalizeInbound('hi​\u0007 there')).toBe('hi there');
    expect(normalizeInbound('helloooooooooooooooo')).toBe('helloooo');
    expect(normalizeInbound('x'.repeat(5000).replace(/x/g, 'ab'))).toHaveLength(1500);
  });

  test('media: photos and voice get a warm reply and a staff alert; stickers and reactions get nothing', () => {
    expect(mediaResponse('image', 'en')).toMatchObject({
      reply: expect.stringMatching(/doctor will look/),
      alertStaff: true,
    });
    expect(mediaResponse('audio', 'hinglish').reply).toMatch(/voice note/);
    expect(mediaResponse('audio', 'hi').reply).toMatch(/वॉइस नोट/);
    expect(mediaResponse('sticker', 'en')).toEqual({ reply: null, alertStaff: false });
    expect(mediaResponse('reaction', 'en').reply).toBeNull();
    expect(isEmojiOnly('👍🙏')).toBe(true);
    expect(isEmojiOnly('ok 👍')).toBe(false);
    expect(isEmojiOnly('2')).toBe(false);
    expect(isEmojiOnly('❤️👍🏽')).toBe(true);
  });

  test.each([
    ['Thank you for contacting ABC Motors. Our team will get back to you shortly.', 'auto_reply'],
    ['This is an automated message, please do not reply', 'auto_reply'],
    ['Boost your Google ranking with our SEO services! www.cheapseo.biz', 'spam'],
    ['Hello sir, we provide digital marketing for clinics at best rates', 'vendor'],
    ['Is there any vacancy for receptionist? I can send my resume', 'job_seeker'],
    ['Sorry, wrong number', 'wrong_number'],
    ['My gums bleed when I brush, can I see a dentist?', 'genuine'],
    ['kitna kharcha hoga braces ka?', 'genuine'],
  ])('rule-based intent: %s -> %s', (text, category) => {
    expect(ruleBasedIntent(text).category).toBe(category);
  });

  test('a customer signal keeps the lead genuine', () => {
    expect(hasCustomerSignal('we provide SEO, also my tooth hurts', [])).toBe(true);
    expect(hasCustomerSignal('need whitening', ['Teeth whitening'])).toBe(true);
    expect(hasCustomerSignal('we provide SEO services', ['Consultation'])).toBe(false);
  });

  test('junk replies: one polite line, or silence', () => {
    expect(notALeadReply('wrong_number', 'Smile Dental', 'en')).toMatch(/Smile Dental/);
    expect(notALeadReply('job_seeker', 'Smile Dental', 'hinglish')).toMatch(/CV/);
    expect(notALeadReply('spam', 'Smile Dental', 'en')).toBeNull();
    expect(notALeadReply('auto_reply', 'Smile Dental', 'en')).toBeNull();
  });

  test('redaction removes direct identifiers, keeps the rest', () => {
    expect(
      redact('call me on +91 98765 43210 or priya@example.com, aadhaar 1234 5678 9012, PAN ABCDE1234F'),
    ).toBe('call me on [phone] or [email], aadhaar [id number], PAN [id number]');
    expect(redact('3 teeth, 2 visits, ₹1,500')).toBe('3 teeth, 2 visits, ₹1,500');
  });
});

describe('outbound', () => {
  const ctx: ReplyContext = {
    sources:
      'Prices: Consultation ₹500. Cleaning ₹1,500. Whitening from ₹8,000. Maps: https://maps.app.goo.gl/abc Call 080 4567 8901',
    allowedUrls: ['https://g.page/r/review'],
    noMedicalAdvice: true,
    language: 'en',
  };

  test('cleanReply strips markdown and caps length at a sentence end', () => {
    expect(cleanReply('## Prices\n**Cleaning** is ₹1,500.\n- one\n- two')).toBe(
      'Prices\nCleaning is ₹1,500.\none\ntwo',
    );
    const long = cleanReply(`${'This is a sentence. '.repeat(60)}`);
    expect(long.length).toBeLessThanOrEqual(700);
    expect(long.endsWith('.')).toBe(true);
  });

  test('a good reply passes', () => {
    expect(
      checkReply(
        'A consultation is ₹500, and our dentist can check that properly. Shall I find you a time?',
        ctx,
      ),
    ).toEqual([]);
    expect(
      checkReply('Here is the map: https://maps.app.goo.gl/abc and you can call 080 4567 8901', ctx),
    ).toEqual([]);
  });

  test.each([
    ['Implants cost ₹25,000.', /price \(₹25000\)/],
    ['You can take paracetamol 500 mg for now.', /medicine/],
    ['I used lookup_knowledge to check.', /internal/],
    ['Book here: https://evil.example/x', /link/],
    ['Call Dr Mehta on 98111 22233.', /phone number/],
  ])('rejects: %s', (reply, problem) => {
    expect(checkReply(reply, ctx).join(' | ')).toMatch(problem);
  });

  test('reply script must match the customer’s language', () => {
    expect(
      checkReply('Thank you, the doctor will see you tomorrow morning at ten.', { ...ctx, language: 'hi' }),
    ).toEqual([expect.stringMatching(/Hindi/)]);
    expect(
      checkReply('धन्यवाद, डॉक्टर कल सुबह दस बजे आपको देखेंगे। क्या यह ठीक है?', {
        ...ctx,
        language: 'hinglish',
      }),
    ).toEqual([expect.stringMatching(/Devanagari/)]);
  });

  test('sameReply ignores punctuation and case', () => {
    expect(sameReply('How soon would you like to come in?', 'how soon would you like to come in')).toBe(true);
  });
});
