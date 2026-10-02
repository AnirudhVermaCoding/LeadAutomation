import { describe, expect, test } from 'vitest';
import { parseLeadEmail } from './lead-email.ts';

// SYNTHETIC samples shaped like portal notification emails. Real layouts differ and change:
// check one real forwarded email per portal during the pilot (docs/LEAD-SOURCES.md).
describe('parseLeadEmail', () => {
  test('labelled plain-text lines', () => {
    expect(
      parseLeadEmail({
        from: 'Leads <noreply@99acres.com>',
        subject: 'New response for your property',
        text: 'You have a new response.\n\nName: Rohit Mehra\nMobile: +91 98765 43210\nEmail: rohit@example.com\nRequirement: 3 BHK in Baner\n',
      }),
    ).toEqual({
      portal: '99acres',
      phone: '+919876543210',
      name: 'Rohit Mehra',
      email: 'rohit@example.com',
      message: '3 BHK in Baner',
    });
  });

  test('html tables and dash separators', () => {
    const html =
      '<table><tr><td>Customer Name</td><td>Anita Desai</td></tr><tr><td>Contact No.</td><td>098765-43211</td></tr></table>';
    const r = parseLeadEmail({ from: 'alerts@magicbricks.com', html });
    expect(r).toMatchObject({ portal: 'MagicBricks', name: 'Anita Desai', phone: '+919876543211' });
    expect(parseLeadEmail({ text: '- Phone - 9876543212\n- Name - Dev' })).toMatchObject({
      phone: '+919876543212',
      name: 'Dev',
    });
  });

  test('falls back to any Indian mobile in the body; the sender address is never the customer', () => {
    const r = parseLeadEmail({ from: 'x@justdial.com', text: 'Please call 9876543213 about a root canal' });
    expect(r).toMatchObject({ portal: 'JustDial', phone: '+919876543213', email: null, name: null });
  });

  test('no phone: nothing to contact', () => {
    expect(parseLeadEmail({ text: 'Name: Someone\nEmail: a@b.co' }).phone).toBeNull();
  });
});
