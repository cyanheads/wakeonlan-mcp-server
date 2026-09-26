/**
 * @fileoverview IPv4 math and the segment-resolution table: configured and
 * derived broadcasts, off-segment results, skipped /0, /31, /32, and null-cidr
 * entries, the loopback fixture, and first-match ordering across NICs.
 * @module tests/services/lan/segment.test
 */

import { describe, expect, it } from 'vitest';
import { intToIpv4, ipv4ToInt, resolveSegment } from '@/services/lan/segment.js';
import {
  EMPTY_TABLE,
  LAN_TABLE,
  LOOPBACK_TABLE,
  TUNNEL_TABLE,
  TWO_NIC_TABLE,
  v4,
  v6,
} from '../../helpers/fixtures.js';

const LOOPBACK_SUBNET = { interface: 'lo0', cidr: '127.0.0.1/8' };
const EN0_SUBNET = { interface: 'en0', cidr: '192.0.2.10/24' };

describe('ipv4ToInt / intToIpv4', () => {
  it.each([
    ['0.0.0.0', 0],
    ['0.0.0.1', 1],
    ['192.0.2.255', 0xc00002ff],
    ['127.0.0.1', 0x7f000001],
    ['128.0.0.0', 0x80000000],
    ['255.255.255.255', 0xffffffff],
  ])('maps %s ↔ %d as an unsigned 32-bit integer', (dotted, value) => {
    expect(ipv4ToInt(dotted)).toBe(value);
    expect(ipv4ToInt(dotted)).toBeGreaterThanOrEqual(0);
    expect(intToIpv4(value)).toBe(dotted);
  });
});

describe('resolveSegment — configured broadcast', () => {
  it("binds to the interface whose directed broadcast matches the profile's", () => {
    expect(resolveSegment({ broadcast: '192.0.2.255' }, LAN_TABLE)).toEqual({
      ok: true,
      broadcast: '192.0.2.255',
      broadcastSource: 'configured',
      interface: 'en0',
      localAddress: '192.0.2.10',
    });
  });

  it('uses the configured broadcast even when the address is a hostname', () => {
    expect(
      resolveSegment({ address: 'nas.home.arpa', broadcast: '192.0.2.255' }, LAN_TABLE),
    ).toMatchObject({ ok: true, broadcastSource: 'configured', interface: 'en0' });
  });

  it('prefers the configured broadcast over one the address would derive', () => {
    const table = {
      en0: [v4('192.0.2.10', '255.255.255.0', '192.0.2.10/24')],
      en5: [v4('198.51.100.9', '255.255.255.0', '198.51.100.9/24')],
    };
    expect(
      resolveSegment({ address: '192.0.2.50', broadcast: '198.51.100.255' }, table),
    ).toMatchObject({ ok: true, broadcast: '198.51.100.255', interface: 'en5' });
  });

  it('is off-segment when no interface has that directed broadcast', () => {
    expect(resolveSegment({ broadcast: '203.0.113.255' }, LAN_TABLE)).toEqual({
      ok: false,
      broadcast: '203.0.113.255',
      broadcastSource: 'configured',
      localSubnets: [LOOPBACK_SUBNET, EN0_SUBNET],
    });
  });

  it("is off-segment when the broadcast is a host address inside the subnet, even this machine's own", () => {
    for (const broadcast of ['192.0.2.10', '192.0.2.0', '192.0.2.254']) {
      expect(resolveSegment({ broadcast }, LAN_TABLE)).toMatchObject({ ok: false });
    }
  });
});

describe('resolveSegment — derived broadcast', () => {
  it("derives the directed broadcast of the /24 that holds the profile's IPv4 address", () => {
    expect(resolveSegment({ address: '192.0.2.50' }, LAN_TABLE)).toEqual({
      ok: true,
      broadcast: '192.0.2.255',
      broadcastSource: 'derived',
      interface: 'en0',
      localAddress: '192.0.2.10',
    });
  });

  it.each([
    ['/20', '10.20.16.3', '255.255.240.0', '10.20.16.3/20', '10.20.31.5', '10.20.31.255'],
    ['/23', '172.16.4.1', '255.255.254.0', '172.16.4.1/23', '172.16.5.200', '172.16.5.255'],
    ['/30', '198.51.100.1', '255.255.255.252', '198.51.100.1/30', '198.51.100.2', '198.51.100.3'],
    ['/8', '10.1.2.3', '255.0.0.0', '10.1.2.3/8', '10.200.0.9', '10.255.255.255'],
    ['/1 low half', '10.0.0.1', '128.0.0.0', '10.0.0.1/1', '100.64.0.1', '127.255.255.255'],
  ])('derives across a %s prefix', (_label, local, netmask, cidr, address, broadcast) => {
    const table = { eth0: [v4(local, netmask, cidr)] };
    expect(resolveSegment({ address }, table)).toMatchObject({
      ok: true,
      broadcast,
      broadcastSource: 'derived',
      interface: 'eth0',
      localAddress: local,
    });
  });

  it('keeps the arithmetic unsigned for subnets above 128.0.0.0', () => {
    const table = { eth0: [v4('203.0.113.77', '255.255.255.128', '203.0.113.77/25')] };
    expect(resolveSegment({ address: '203.0.113.100' }, table)).toMatchObject({
      ok: true,
      broadcast: '203.0.113.127',
    });
    expect(resolveSegment({ address: '203.0.113.200' }, table)).toMatchObject({ ok: false });
  });

  it('is unresolved when the IPv4 address sits on no local subnet', () => {
    expect(resolveSegment({ address: '198.51.100.20' }, LAN_TABLE)).toEqual({
      ok: false,
      broadcastSource: 'unresolved',
      localSubnets: [LOOPBACK_SUBNET, EN0_SUBNET],
    });
  });

  it.each([
    ['a hostname', 'nas.home.arpa'],
    ['an IPv6 literal', '2001:db8::50'],
    ['no address', undefined],
  ])('is unresolved with %s and no configured broadcast', (_label, address) => {
    const profile = address === undefined ? {} : { address };
    expect(resolveSegment(profile, LAN_TABLE)).toEqual({
      ok: false,
      broadcastSource: 'unresolved',
      localSubnets: [LOOPBACK_SUBNET, EN0_SUBNET],
    });
  });

  it('is unresolved on an empty interface table, comparing against nothing', () => {
    expect(resolveSegment({ address: '192.0.2.50' }, EMPTY_TABLE)).toEqual({
      ok: false,
      broadcastSource: 'unresolved',
      localSubnets: [],
    });
  });
});

describe('resolveSegment — skipped entries', () => {
  it('skips /31 and /32 point-to-point entries for both configured and derived broadcasts', () => {
    // A /31's arithmetic "broadcast" is its upper address; a /32's is the address itself.
    for (const profile of [
      { address: '203.0.113.1' },
      { broadcast: '203.0.113.1' },
      { address: '198.51.100.7' },
      { broadcast: '198.51.100.7' },
    ]) {
      expect(resolveSegment(profile, TUNNEL_TABLE)).toMatchObject({
        ok: false,
        localSubnets: [LOOPBACK_SUBNET],
      });
    }
  });

  it('skips a /0 entry, so it can neither derive 255.255.255.255 nor mark every host on-segment', () => {
    const table = { lo0: LOOPBACK_TABLE.lo0, wg0: [v4('10.0.0.5', '0.0.0.0', '10.0.0.5/0')] };
    expect(resolveSegment({ address: '10.1.2.3' }, table)).toEqual({
      ok: false,
      broadcastSource: 'unresolved',
      localSubnets: [LOOPBACK_SUBNET],
    });
    expect(resolveSegment({ address: '198.51.100.20' }, table)).toMatchObject({ ok: false });
    expect(resolveSegment({ broadcast: '255.255.255.255' }, table)).toMatchObject({ ok: false });
  });

  it("skips an entry whose cidr is null (Node's invalid-netmask marker)", () => {
    const table = { en0: [v4('192.0.2.10', '255.0.255.0', null)] };
    expect(resolveSegment({ address: '192.0.2.50' }, table)).toEqual({
      ok: false,
      broadcastSource: 'unresolved',
      localSubnets: [],
    });
  });

  it('ignores IPv6 entries and interfaces that report no addresses', () => {
    const table = {
      en0: [v6('2001:db8::10', '2001:db8::10/64')],
      en7: undefined,
      en1: [v4('192.0.2.10', '255.255.255.0', '192.0.2.10/24')],
    };
    expect(resolveSegment({ address: '192.0.2.50' }, table)).toMatchObject({
      ok: true,
      interface: 'en1',
    });
    expect(resolveSegment({ address: '198.51.100.1' }, table)).toMatchObject({
      localSubnets: [{ interface: 'en1', cidr: '192.0.2.10/24' }],
    });
  });
});

describe('resolveSegment — loopback verification fixture', () => {
  it("accepts a configured broadcast equal to a loopback entry's own address", () => {
    expect(
      resolveSegment({ address: '127.0.0.1', broadcast: '127.0.0.1' }, LOOPBACK_TABLE),
    ).toEqual({
      ok: true,
      broadcast: '127.0.0.1',
      broadcastSource: 'configured',
      interface: 'lo0',
      localAddress: '127.0.0.1',
    });
  });

  it("derives the loopback entry's own address as the broadcast", () => {
    expect(resolveSegment({ address: '127.0.0.1' }, LOOPBACK_TABLE)).toEqual({
      ok: true,
      broadcast: '127.0.0.1',
      broadcastSource: 'derived',
      interface: 'lo0',
      localAddress: '127.0.0.1',
    });
  });

  it('matches loopback by exact address only, never by subnet', () => {
    expect(resolveSegment({ address: '127.0.0.2' }, LOOPBACK_TABLE)).toMatchObject({
      ok: false,
      broadcastSource: 'unresolved',
    });
    expect(resolveSegment({ broadcast: '127.255.255.255' }, LOOPBACK_TABLE)).toMatchObject({
      ok: false,
      broadcastSource: 'configured',
    });
  });
});

describe('resolveSegment — several matching interfaces', () => {
  it('picks the first match in networkInterfaces() order', () => {
    expect(resolveSegment({ address: '192.0.2.50' }, TWO_NIC_TABLE)).toMatchObject({
      interface: 'en0',
      localAddress: '192.0.2.10',
    });
    expect(resolveSegment({ broadcast: '192.0.2.255' }, TWO_NIC_TABLE)).toMatchObject({
      interface: 'en0',
      localAddress: '192.0.2.10',
    });
  });

  it('follows the table order, not the interface name', () => {
    const reversed = { en1: TWO_NIC_TABLE.en1, en0: TWO_NIC_TABLE.en0 };
    expect(resolveSegment({ address: '192.0.2.50' }, reversed)).toMatchObject({
      interface: 'en1',
      localAddress: '192.0.2.11',
    });
  });

  it('skips a non-matching first interface to reach the matching one', () => {
    const table = {
      en0: [v4('198.51.100.9', '255.255.255.0', '198.51.100.9/24')],
      en1: [v4('192.0.2.11', '255.255.255.0', '192.0.2.11/24')],
    };
    expect(resolveSegment({ address: '192.0.2.50' }, table)).toMatchObject({ interface: 'en1' });
  });

  it('matches the second address of an interface that carries two IPv4 subnets', () => {
    const table = {
      en0: [
        v4('198.51.100.9', '255.255.255.0', '198.51.100.9/24'),
        v4('192.0.2.10', '255.255.255.0', '192.0.2.10/24'),
      ],
    };
    expect(resolveSegment({ address: '192.0.2.50' }, table)).toMatchObject({
      interface: 'en0',
      localAddress: '192.0.2.10',
    });
  });
});
