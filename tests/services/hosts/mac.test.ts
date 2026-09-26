/**
 * @fileoverview MAC and SecureOn parsing table: every accepted textual form,
 * zero-padding of one-digit groups, and every rejection (mixed separators,
 * wrong lengths, garbage, group bit, all zeros).
 * @module tests/services/hosts/mac.test
 */

import { describe, expect, it } from 'vitest';
import { macToBytes, parseMac, parseSecureOn } from '@/services/hosts/mac.js';

const ACCEPTED: ReadonlyArray<readonly [input: string, normalized: string]> = [
  ['00:00:5e:00:53:01', '00:00:5e:00:53:01'],
  ['00:00:5E:00:53:01', '00:00:5e:00:53:01'],
  ['00-00-5E-00-53-01', '00:00:5e:00:53:01'],
  ['00-00-5e-00-53-01', '00:00:5e:00:53:01'],
  ['0:0:5e:0:53:1', '00:00:5e:00:53:01'],
  ['0-0-5E-0-53-1', '00:00:5e:00:53:01'],
  ['a:b:c:d:e:f', '0a:0b:0c:0d:0e:0f'],
  ['0000.5e00.5301', '00:00:5e:00:53:01'],
  ['0000.5E00.5301', '00:00:5e:00:53:01'],
  ['00005e005301', '00:00:5e:00:53:01'],
  ['00005E005301', '00:00:5e:00:53:01'],
  ['Aa:bB:cc:DD:ee:FF', 'aa:bb:cc:dd:ee:ff'],
];

const FORMAT_REJECTED: readonly string[] = [
  '',
  '00:00-5e:00-53:01', // mixed separators
  '00-00:5e-00:53-01',
  '00:00:5e:00:53', // five groups
  '00:00:5e:00:53:01:02', // seven groups
  '000:00:5e:00:53:01', // three-digit group
  '00::5e:00:53:01', // empty group
  '00:00:5e:00:53:01:', // trailing separator
  ':00:00:5e:00:53:01',
  '00.00.5e.00.53.01', // dots between single bytes
  '00_00_5e_00_53_01',
  '00 00 5e 00 53 01',
  '00005e00530', // 11 digits
  '00005e0053011', // 13 digits
  '0000.5e00.530', // short Cisco group
  '0000.5e00.53011',
  '00005e.005301',
  '0000:5e00:5301', // Cisco grouping with colons
  'gg:00:5e:00:53:01', // non-hex
  '00:00:5e:00:53:0g',
  'not-a-mac',
  ' 00:00:5e:00:53:01', // surrounding whitespace is not trimmed
  '00:00:5e:00:53:01 ',
  '00:00:5e:00:53:01\n',
  '0x00005e005301',
  '０0:00:5e:00:53:01', // full-width digit
];

describe('parseMac', () => {
  it.each(ACCEPTED)('accepts %j as %s', (input, normalized) => {
    expect(parseMac(input)).toEqual({ ok: true, value: normalized });
  });

  it.each(FORMAT_REJECTED)('rejects %j as a format error', (input) => {
    expect(parseMac(input)).toEqual({ ok: false, reason: 'format' });
  });

  it.each([
    '01:00:5e:00:00:fb', // IPv4 multicast
    '33:33:00:00:00:01', // IPv6 multicast
    'ff:ff:ff:ff:ff:ff', // broadcast
    '03-00-00-00-00-01',
    '0100.5e00.00fb',
    '01005e0000fb',
    '1:0:0:0:0:0',
  ])('rejects the group (multicast/broadcast) address %s', (input) => {
    expect(parseMac(input)).toEqual({ ok: false, reason: 'group' });
  });

  it.each([
    '00:00:00:00:00:00',
    '00-00-00-00-00-00',
    '0:0:0:0:0:0',
    '0000.0000.0000',
    '000000000000',
  ])('rejects the all-zero address %s', (input) => {
    expect(parseMac(input)).toEqual({ ok: false, reason: 'zero' });
  });

  it('accepts a locally administered unicast address (bit 1 set, group bit clear)', () => {
    expect(parseMac('02:00:5e:10:00:01')).toEqual({ ok: true, value: '02:00:5e:10:00:01' });
  });
});

describe('parseSecureOn', () => {
  it.each(ACCEPTED)('accepts %j as %s', (input, normalized) => {
    expect(parseSecureOn(input)).toEqual({ ok: true, value: normalized });
  });

  it.each(FORMAT_REJECTED)('rejects %j as a format error', (input) => {
    expect(parseSecureOn(input)).toEqual({ ok: false, reason: 'format' });
  });

  it('accepts a password with the group bit set, which parseMac rejects', () => {
    expect(parseMac('01:23:45:67:89:ab')).toEqual({ ok: false, reason: 'group' });
    expect(parseSecureOn('01:23:45:67:89:ab')).toEqual({ ok: true, value: '01:23:45:67:89:ab' });
    expect(parseSecureOn('FF-FF-FF-FF-FF-FF')).toEqual({ ok: true, value: 'ff:ff:ff:ff:ff:ff' });
  });

  it('accepts an all-zero password, which parseMac rejects', () => {
    expect(parseMac('000000000000')).toEqual({ ok: false, reason: 'zero' });
    expect(parseSecureOn('000000000000')).toEqual({ ok: true, value: '00:00:00:00:00:00' });
  });
});

describe('macToBytes', () => {
  it('converts lowercase colon form to the six raw bytes', () => {
    expect([...macToBytes('00:00:5e:00:53:01')]).toEqual([0x00, 0x00, 0x5e, 0x00, 0x53, 0x01]);
    expect([...macToBytes('a1:b2:c3:d4:e5:f6')]).toEqual([0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6]);
  });
});
