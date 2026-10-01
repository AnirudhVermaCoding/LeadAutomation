import { expect, test } from 'vitest';
import { csvRecords, parseCsv } from './csv.ts';

const BOM = String.fromCharCode(0xfeff);

test('handles quotes, escaped quotes, embedded commas/newlines, CRLF and BOM', () => {
  const text = `${BOM}phone,name,notes\r\n9876543210,"Sharma, Priya","said ""call me""\nafter 6"\r\n\r\n+919812345678,Ravi,\n`;
  expect(parseCsv(text)).toEqual([
    ['phone', 'name', 'notes'],
    ['9876543210', 'Sharma, Priya', 'said "call me"\nafter 6'],
    ['+919812345678', 'Ravi', ''],
  ]);
});

test('records use trimmed lower-case headers', () => {
  expect(csvRecords(' Phone , Consent\n98765 43210 , yes')).toEqual([
    { phone: '98765 43210', consent: 'yes' },
  ]);
  expect(csvRecords('')).toEqual([]);
});
