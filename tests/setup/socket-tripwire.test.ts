/**
 * @fileoverview Canary for the socket tripwire in `tests/setup/socket-tripwire.ts`.
 * `LanService` runs with its production socket factories while the interface
 * table and clock stay faked, so no host network state is read. If this suite
 * ever passes without hitting the tripwire, the setup file is not loaded and the
 * rest of the suite could open real sockets.
 * @module tests/setup/socket-tripwire.test
 */

import dgram, { createSocket, Socket as UdpSocket } from 'node:dgram';
import net, { connect, createConnection, isIP, isIPv4, Socket as TcpSocket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { getLanService, initLanService } from '@/services/lan/lan-service.js';
import { LOOPBACK_TABLE, PROFILES } from '../helpers/fixtures.js';
import { VirtualClock } from '../helpers/lan-fakes.js';

const TRIPWIRE = 'Real socket opened in a test: inject createUdpSocket / connectTcp';

describe('socket tripwire', () => {
  it('blocks the send and probe paths of a LanService left on its default socket factories', async () => {
    initLanService({
      networkInterfaces: () => LOOPBACK_TABLE,
      clock: new VirtualClock(),
      platform: 'linux',
    });
    const lan = getLanService();
    const signal = new AbortController().signal;
    const profile = {
      alias: PROFILES.loopback.alias,
      mac: PROFILES.loopback.mac,
      address: PROFILES.loopback.address,
      broadcast: PROFILES.loopback.broadcast,
      wol_port: PROFILES.loopback.wol_port,
      check_port: PROFILES.loopback.check_port,
    };
    const segment = lan.resolveSegment(profile);
    if (!segment.ok) throw new Error('loopback fixture must resolve');

    await expect(lan.wake(profile, segment, 0, signal)).rejects.toThrow(TRIPWIRE);
    await expect(lan.probe('127.0.0.1', 40022, 1500, signal)).rejects.toThrow(TRIPWIRE);
  });

  it('replaces every socket entry point on both modules, named and default', () => {
    expect(() => createSocket('udp4')).toThrow(TRIPWIRE);
    expect(() => dgram.createSocket('udp4')).toThrow(TRIPWIRE);
    expect(() => new UdpSocket()).toThrow(TRIPWIRE);
    expect(() => new dgram.Socket()).toThrow(TRIPWIRE);
    expect(() => connect({ host: '127.0.0.1', port: 1 })).toThrow(TRIPWIRE);
    expect(() => createConnection({ host: '127.0.0.1', port: 1 })).toThrow(TRIPWIRE);
    expect(() => net.connect({ host: '127.0.0.1', port: 1 })).toThrow(TRIPWIRE);
    expect(() => net.createConnection({ host: '127.0.0.1', port: 1 })).toThrow(TRIPWIRE);
    expect(() => new TcpSocket()).toThrow(TRIPWIRE);
    expect(() => new net.Socket()).toThrow(TRIPWIRE);
  });

  it('leaves the non-socket exports real', () => {
    expect(isIP('192.0.2.1')).toBe(4);
    expect(isIP('2001:db8::1')).toBe(6);
    expect(isIPv4('nas.home.arpa')).toBe(false);
    expect(net.isIPv6('::1')).toBe(true);
  });
});
