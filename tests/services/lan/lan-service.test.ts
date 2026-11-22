/**
 * @fileoverview LanService against faked sockets, interfaces, and a virtual
 * clock: probe classification and cleanup, the bind → setBroadcast → send ×3 →
 * close sequence, every send-failure stage, the wake state machine with its
 * poll schedule, deadline clamp, and closing probe, and cancellation at each
 * wait.
 * @module tests/services/lan/lan-service.test
 */

import { describe, expect, it, vi } from 'vitest';
import { loadHostsConfig } from '@/services/hosts/hosts-config.js';
import type { HostProfile } from '@/services/hosts/types.js';
import {
  classifyConnectError,
  LanService,
  PACKET_COUNT,
  PACKET_SPACING_MS,
  POLL_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
} from '@/services/lan/lan-service.js';
import {
  LAN_TABLE,
  LOOPBACK_TABLE,
  magicPacketHex,
  PROFILES,
  SECUREON,
} from '../../helpers/fixtures.js';
import {
  coded,
  createLanFakes,
  LATENCY,
  type LanFakeOptions,
  type TcpBehavior,
} from '../../helpers/lan-fakes.js';

const START = 50_000;

async function profileOf(entry: object): Promise<HostProfile> {
  const [profile] = (await loadHostsConfig({ hostsJson: JSON.stringify([entry]) })).profiles;
  if (!profile) throw new Error('fixture profile failed to load');
  return profile;
}

function setup(options: LanFakeOptions = {}) {
  const fakes = createLanFakes({ start: START, ...options });
  const lan = new LanService(fakes.deps);
  const segmentOf = (profile: HostProfile) => {
    const segment = lan.resolveSegment(profile);
    if (!segment.ok) throw new Error(`fixture ${profile.alias} is off-segment`);
    return segment;
  };
  // Object.assign, not a spread: a spread would snapshot the interfaceReads getter.
  return Object.assign(fakes, { lan, segmentOf });
}

const live = () => new AbortController().signal;

describe('classifyConnectError', () => {
  it.each([
    ['ECONNREFUSED', coded('ECONNREFUSED'), 'refused'],
    ['EHOSTUNREACH', coded('EHOSTUNREACH'), 'no_answer'],
    ['EHOSTDOWN', coded('EHOSTDOWN'), 'no_answer'],
    ['ENETUNREACH', coded('ENETUNREACH'), 'no_answer'],
    ['ETIMEDOUT', coded('ETIMEDOUT'), 'no_answer'],
    ['ENOTFOUND (DNS failure)', coded('ENOTFOUND'), 'no_answer'],
    ['an error with no code', new Error('socket hang up'), 'no_answer'],
    ['a non-string code', Object.assign(new Error('x'), { code: 111 }), 'no_answer'],
    ['a thrown string', 'ECONNREFUSED', 'no_answer'],
    ['null', null, 'no_answer'],
  ])('classifies %s', (_label, error, outcome) => {
    expect(classifyConnectError(error)).toBe(outcome);
  });

  it("finds ECONNREFUSED in a later attempt of a multi-address AggregateError whose own code is the first attempt's", () => {
    const aggregate = Object.assign(
      new AggregateError([coded('ETIMEDOUT'), coded('ECONNREFUSED')], 'connect failed'),
      { code: 'ETIMEDOUT' },
    );
    expect(classifyConnectError(aggregate)).toBe('refused');
  });

  it('reads an AggregateError with no refusal among its attempts as no_answer', () => {
    const aggregate = Object.assign(
      new AggregateError([coded('ETIMEDOUT'), coded('EHOSTUNREACH')], 'connect failed'),
      { code: 'ETIMEDOUT' },
    );
    expect(classifyConnectError(aggregate)).toBe('no_answer');
    expect(classifyConnectError(new AggregateError([], 'empty'))).toBe('no_answer');
  });
});

describe('LanService.probe', () => {
  it('reports open with the connect latency on the virtual clock, then destroys the socket', async () => {
    const { lan, tcp, clock } = setup({ tcp: { '192.0.2.50': ['open'] } });
    const result = await lan.probe('192.0.2.50', 22, PROBE_TIMEOUT_MS, live());
    expect(result).toEqual({
      outcome: 'open',
      answeredAt: START + LATENCY.open,
      latencyMs: LATENCY.open,
    });
    expect(tcp.connects).toHaveLength(1);
    expect(tcp.connects[0]).toMatchObject({ host: '192.0.2.50', port: 22, at: START });
    expect(tcp.connects[0]?.socket.log).toEqual([
      'once:error',
      'once:connect',
      'remove:connect',
      'destroy',
    ]);
    // The timeout sleep started with the connect and was cancelled once it answered.
    expect(clock.sleeps).toEqual([{ at: START, ms: PROBE_TIMEOUT_MS }]);
    expect(clock.now()).toBe(START + LATENCY.open);
    expect(clock.pending).toBe(0);
  });

  it('reports refused with its latency for ECONNREFUSED', async () => {
    const { lan, tcp } = setup({ tcp: { 'nas.home.arpa': [{ kind: 'refused', afterMs: 17 }] } });
    await expect(lan.probe('nas.home.arpa', 445, PROBE_TIMEOUT_MS, live())).resolves.toEqual({
      outcome: 'refused',
      answeredAt: START + 17,
      latencyMs: 17,
    });
    expect(tcp.connects[0]?.socket.destroyCount).toBe(1);
  });

  it('reports no_answer at once for an unreachable host rather than waiting out the timeout', async () => {
    const { lan, clock, tcp } = setup({ tcp: { '192.0.2.50': ['unreachable'] } });
    await expect(lan.probe('192.0.2.50', 22, PROBE_TIMEOUT_MS, live())).resolves.toEqual({
      outcome: 'no_answer',
    });
    expect(clock.now()).toBe(START + LATENCY.unreachable);
    expect(tcp.connects[0]?.socket.destroyCount).toBe(1);
  });

  it('reports no_answer when nothing answers within the timeout, and destroys the socket', async () => {
    const { lan, clock, tcp } = setup({ tcp: { '192.0.2.50': ['silent'] } });
    await expect(lan.probe('192.0.2.50', 22, 1000, live())).resolves.toEqual({
      outcome: 'no_answer',
    });
    expect(clock.now()).toBe(START + 1000);
    expect(tcp.connects[0]?.socket.destroyCount).toBe(1);
  });

  it('ignores an answer that arrives after the timeout', async () => {
    const { lan, clock, tcp } = setup({
      tcp: { '192.0.2.50': [{ kind: 'open', afterMs: PROBE_TIMEOUT_MS + 500 }] },
    });
    await expect(lan.probe('192.0.2.50', 22, PROBE_TIMEOUT_MS, live())).resolves.toEqual({
      outcome: 'no_answer',
    });
    expect(clock.now()).toBe(START + PROBE_TIMEOUT_MS);
    expect(tcp.connects[0]?.socket.listenerCount('connect')).toBe(0);
  });

  it('classifies a multi-address AggregateError with a later refusal as refused', async () => {
    const aggregate = Object.assign(
      new AggregateError([coded('ETIMEDOUT'), coded('ECONNREFUSED')], 'connect failed'),
      { code: 'ETIMEDOUT' },
    );
    const { lan } = setup({
      tcp: { 'nas.home.arpa': [{ kind: 'error', error: aggregate, afterMs: 250 }] },
    });
    await expect(lan.probe('nas.home.arpa', 22, PROBE_TIMEOUT_MS, live())).resolves.toMatchObject({
      outcome: 'refused',
      latencyMs: 250,
    });
  });

  it('keeps its error listener after destroy so a late socket error is never unhandled', async () => {
    const { lan, tcp } = setup({ tcp: { '192.0.2.50': ['open'] } });
    await lan.probe('192.0.2.50', 22, PROBE_TIMEOUT_MS, live());
    const socket = tcp.connects[0]?.socket;
    expect(socket?.listenerCount('error')).toBe(1);
    expect(() => socket?.emit('error', coded('ECONNRESET'))).not.toThrow();
  });

  it('rejects without connecting when the signal is already aborted', async () => {
    const { lan, tcp } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      lan.probe('192.0.2.50', 22, PROBE_TIMEOUT_MS, controller.signal),
    ).rejects.toThrow();
    expect(tcp.connects).toHaveLength(0);
  });

  it('rejects with an AbortError when aborted mid-probe, destroying the socket', async () => {
    const { lan, tcp, clock } = setup({ tcp: { '192.0.2.50': ['silent'] } });
    const controller = new AbortController();
    clock.schedule(400, () => controller.abort());
    await expect(
      lan.probe('192.0.2.50', 22, PROBE_TIMEOUT_MS, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(clock.now()).toBe(START + 400);
    expect(tcp.connects[0]?.socket.destroyCount).toBe(1);
    expect(clock.pending).toBe(0);
  });
});

describe('LanService — interfaces, clock, platform', () => {
  it('reads the interface table on every resolution, so a roaming machine is re-evaluated', async () => {
    const fakes = setup();
    const gpuBox = await profileOf(PROFILES.gpuBox);
    expect(fakes.lan.resolveSegment(gpuBox)).toMatchObject({ ok: true, interface: 'en0' });
    fakes.setInterfaces(LOOPBACK_TABLE);
    expect(fakes.lan.resolveSegment(gpuBox)).toMatchObject({
      ok: false,
      broadcastSource: 'unresolved',
    });
    fakes.setInterfaces(LAN_TABLE);
    expect(fakes.lan.resolveSegment(gpuBox)).toMatchObject({ ok: true });
    expect(fakes.interfaceReads).toBe(3);
  });

  it('exposes the injected clock and platform', () => {
    const { lan } = setup({ platform: 'win32' });
    expect(lan.now()).toBe(START);
    expect(lan.platform).toBe('win32');
  });
});

describe('LanService.wake — the send', () => {
  it('binds to the matched interface, enables broadcast, sends 3 packets 500 ms apart, then closes', async () => {
    const fakes = setup();
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live());

    expect(result).toEqual({
      kind: 'sent',
      state: 'unverified',
      unverifiedReason: 'wait_disabled',
    });
    expect(fakes.udp.requestedTypes).toEqual(['udp4']);
    const socket = fakes.udp.only;
    expect(socket.ops).toEqual([
      'once',
      'bind',
      'setBroadcast',
      'send',
      'send',
      'send',
      'removeListener',
      'close',
    ]);
    expect(socket.calls[0]).toEqual({ op: 'once', event: 'error' });
    expect(socket.calls[1]).toEqual({ op: 'bind', address: '192.0.2.10', port: 0 });
    expect(socket.calls[2]).toEqual({ op: 'setBroadcast', flag: true });
    const expected = magicPacketHex('00005e005301');
    expect(socket.sends.map((s) => [s.address, s.port, s.at])).toEqual([
      ['192.0.2.255', 9, START],
      ['192.0.2.255', 9, START + PACKET_SPACING_MS],
      ['192.0.2.255', 9, START + 2 * PACKET_SPACING_MS],
    ]);
    for (const send of socket.sends) expect(send.bytes.equals(expected)).toBe(true);
    expect(socket.closed).toBe(true);
    expect(fakes.tcp.connects).toHaveLength(0);
  });

  it('sends 108-byte packets carrying the SecureOn password', async () => {
    const fakes = setup();
    const nas = await profileOf(PROFILES.nas);
    await fakes.lan.wake(nas, fakes.segmentOf(nas), 0, live());
    const expected = magicPacketHex('00005e005302', SECUREON.stored.replaceAll(':', ''));
    expect(fakes.udp.only.sends).toHaveLength(PACKET_COUNT);
    for (const send of fakes.udp.only.sends) {
      expect(send.bytes).toHaveLength(108);
      expect(send.bytes.equals(expected)).toBe(true);
    }
  });

  it("sends to the profile's wol_port", async () => {
    const fakes = setup();
    const v6Box = await profileOf(PROFILES.v6Box);
    await fakes.lan.wake(v6Box, fakes.segmentOf(v6Box), 0, live());
    expect(fakes.udp.only.sends.map((s) => s.port)).toEqual([7, 7, 7]);
  });

  it('binds to loopback and sends to it for the loopback verification profile', async () => {
    const fakes = setup({ interfaces: LOOPBACK_TABLE });
    const loopback = await profileOf(PROFILES.loopback);
    await fakes.lan.wake(loopback, fakes.segmentOf(loopback), 0, live());
    expect(fakes.udp.only.calls[1]).toEqual({ op: 'bind', address: '127.0.0.1', port: 0 });
    expect(fakes.udp.only.sends.map((s) => `${s.address}:${s.port}`)).toEqual([
      '127.0.0.1:40009',
      '127.0.0.1:40009',
      '127.0.0.1:40009',
    ]);
  });

  it('opens one fresh socket per wake', async () => {
    const fakes = setup();
    const gpuBox = await profileOf(PROFILES.gpuBox);
    await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live());
    await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live());
    expect(fakes.udp.sockets).toHaveLength(2);
    expect(fakes.udp.sockets.every((s) => s.closed)).toBe(true);
  });
});

describe('LanService.wake — send failures', () => {
  it('fails at bind when the socket emits an error, never enabling broadcast', async () => {
    const fakes = setup({ udp: { bindError: coded('EADDRNOTAVAIL') } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    await expect(fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live())).resolves.toEqual({
      kind: 'send_failed',
      stage: 'bind',
      packetsSent: 0,
      code: 'EADDRNOTAVAIL',
    });
    expect(fakes.udp.only.ops).toEqual(['once', 'bind', 'removeListener', 'close']);
  });

  it('fails at set_broadcast when setBroadcast throws', async () => {
    const fakes = setup({ udp: { setBroadcastError: coded('EACCES') } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    await expect(fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live())).resolves.toEqual({
      kind: 'send_failed',
      stage: 'set_broadcast',
      packetsSent: 0,
      code: 'EACCES',
    });
    expect(fakes.udp.only.ops).toEqual(['once', 'bind', 'setBroadcast', 'removeListener', 'close']);
  });

  it.each([1, 2, 3])(
    'fails at send when send #%d fails, counting the packets that left',
    async (nth) => {
      const fakes = setup({ udp: { failSend: { nth, error: coded('ENETUNREACH') } } });
      const gpuBox = await profileOf(PROFILES.gpuBox);
      await expect(fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live())).resolves.toEqual({
        kind: 'send_failed',
        stage: 'send',
        packetsSent: nth - 1,
        code: 'ENETUNREACH',
      });
      const socket = fakes.udp.only;
      expect(socket.sends).toHaveLength(nth);
      expect(socket.ops.slice(-2)).toEqual(['removeListener', 'close']);
      expect(socket.closed).toBe(true);
    },
  );

  it("routes an 'error' event during a send to the send stage", async () => {
    const fakes = setup({ udp: { errorEventOnSend: { nth: 2, error: coded('EPERM') } } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    await expect(fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live())).resolves.toEqual({
      kind: 'send_failed',
      stage: 'send',
      packetsSent: 1,
      code: 'EPERM',
    });
    expect(fakes.udp.only.closed).toBe(true);
  });

  it('omits the code when the failure carries none', async () => {
    const fakes = setup({ udp: { failSend: { nth: 1, error: new Error('no code') } } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live());
    expect(result).toEqual({ kind: 'send_failed', stage: 'send', packetsSent: 0 });
  });

  it('reports a failed send even when the pre-probe found the host awake', async () => {
    const fakes = setup({
      tcp: { '192.0.2.50': ['open'] },
      udp: { failSend: { nth: 3, error: coded('ENOBUFS') } },
    });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    await expect(fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 30, live())).resolves.toEqual({
      kind: 'send_failed',
      stage: 'send',
      packetsSent: 2,
      code: 'ENOBUFS',
    });
  });
});

describe('LanService.wake — states and the poll schedule', () => {
  it('returns already_awake after one open pre-probe, still sending every packet and never polling', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['open'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 30, live());
    expect(result).toEqual({
      kind: 'sent',
      state: 'already_awake',
      probe: { address: '192.0.2.50', port: 22, attempts: 1, last_outcome: 'open' },
    });
    expect(fakes.tcp.connects).toHaveLength(1);
    const sends = fakes.udp.only.sends;
    expect(sends).toHaveLength(PACKET_COUNT);
    // Packets go out after the pre-probe answered.
    expect(sends[0]?.at).toBe(START + LATENCY.open);
    expect(fakes.clock.now()).toBe(START + LATENCY.open + 2 * PACKET_SPACING_MS);
  });

  it('returns awake with time_to_answer_ms from the first packet, polling every 2 s from it', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['silent', 'silent', 'open'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 30, live());

    const t0 = START + PROBE_TIMEOUT_MS; // the pre-probe times out, then the first packet goes
    expect(fakes.udp.only.sends[0]?.at).toBe(t0);
    expect(fakes.tcp.connects.map((c) => c.at)).toEqual([
      START,
      t0 + POLL_INTERVAL_MS,
      t0 + 2 * POLL_INTERVAL_MS,
    ]);
    expect(result).toEqual({
      kind: 'sent',
      state: 'awake',
      probe: { address: '192.0.2.50', port: 22, attempts: 3, last_outcome: 'open' },
      timeToAnswerMs: 2 * POLL_INTERVAL_MS + LATENCY.open,
    });
    for (const connect of fakes.tcp.connects) expect(connect.socket.destroyCount).toBe(1);
  });

  it('returns awake on the first poll after a refused pre-probe', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['refused', 'open'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 30, live());
    expect(result).toMatchObject({
      state: 'awake',
      probe: { attempts: 2, last_outcome: 'open' },
      timeToAnswerMs: POLL_INTERVAL_MS + LATENCY.open,
    });
  });

  it('returns not_reachable with no_answer after the closing probe, clamping the last in-window poll to the deadline', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['silent'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 5, live());

    const t0 = START + PROBE_TIMEOUT_MS;
    const deadline = t0 + 5000;
    expect(result).toEqual({
      kind: 'sent',
      state: 'not_reachable',
      probe: { address: '192.0.2.50', port: 22, attempts: 4, last_outcome: 'no_answer' },
    });
    expect(fakes.clock.sleeps).toEqual([
      { at: START, ms: PROBE_TIMEOUT_MS }, // pre-probe timeout
      { at: t0, ms: PACKET_SPACING_MS },
      { at: t0 + 500, ms: PACKET_SPACING_MS },
      { at: t0 + 1000, ms: 1000 }, // wait for the t0 + 2 s poll
      { at: t0 + 2000, ms: PROBE_TIMEOUT_MS },
      { at: t0 + 3500, ms: 500 }, // wait for the t0 + 4 s poll
      { at: t0 + 4000, ms: 1000 }, // clamped: only 1 s remains before the deadline
      { at: deadline, ms: PROBE_TIMEOUT_MS }, // the closing probe, with the full timeout
    ]);
    expect(fakes.clock.now()).toBe(deadline + PROBE_TIMEOUT_MS);
  });

  it('returns not_reachable with refused when every probe is refused', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['refused'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 5, live());
    const t0 = START + LATENCY.refused;
    expect(result).toMatchObject({
      state: 'not_reachable',
      probe: { attempts: 4, last_outcome: 'refused' },
    });
    expect(fakes.tcp.connects.map((c) => c.at)).toEqual([START, t0 + 2000, t0 + 4000, t0 + 5000]);
  });

  it('reports the last outcome, not the first, when outcomes change across polls', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['refused', 'refused', 'silent'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 5, live());
    expect(result).toMatchObject({ probe: { attempts: 4, last_outcome: 'no_answer' } });
  });

  // wait_for_s → total probes, and when the call returns relative to the first packet (t0).
  // A poll runs only inside the window, so a window shorter than the 2 s poll interval
  // has none; every window then ends with the closing probe, which times out 1.5 s later.
  it.each([
    [1, 2, 2500],
    [2, 2, 3500],
    [3, 3, 4500],
    [4, 3, 5500],
    [5, 4, 6500],
  ])(
    'with wait_for_s %d, probes %d time(s) and returns at t0 + %d ms',
    async (waitForS, attempts, endsAt) => {
      const fakes = setup({ tcp: { '192.0.2.50': ['silent'] } });
      const gpuBox = await profileOf(PROFILES.gpuBox);
      const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), waitForS, live());
      expect(result).toMatchObject({ state: 'not_reachable', probe: { attempts } });
      const t0 = START + PROBE_TIMEOUT_MS;
      expect(fakes.clock.now()).toBe(t0 + endsAt);
      expect(fakes.clock.now()).toBeLessThanOrEqual(t0 + waitForS * 1000 + PROBE_TIMEOUT_MS);
    },
  );

  it('never runs past the 1.5 s pre-probe + wait_for_s + the 1.5 s closing probe at the 55 s cap', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['silent'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 55, live());
    expect(result).toMatchObject({ state: 'not_reachable', probe: { attempts: 29 } });
    expect(fakes.clock.now() - START).toBe(PROBE_TIMEOUT_MS + 55_000 + PROBE_TIMEOUT_MS);
    // The 28th probe starts at t0 + 54 s with only 1 s left before the deadline; the 29th
    // is the closing probe at the deadline.
    expect(fakes.clock.sleeps.slice(-2)).toEqual([
      { at: START + PROBE_TIMEOUT_MS + 54_000, ms: 1000 },
      { at: START + PROBE_TIMEOUT_MS + 55_000, ms: PROBE_TIMEOUT_MS },
    ]);
  });

  it('returns unverified (no_address) with no probe for a profile without an address', async () => {
    const fakes = setup();
    const printer = await profileOf(PROFILES.printer);
    for (const waitForS of [30, 0]) {
      await expect(
        fakes.lan.wake(printer, fakes.segmentOf(printer), waitForS, live()),
      ).resolves.toEqual({ kind: 'sent', state: 'unverified', unverifiedReason: 'no_address' });
    }
    expect(fakes.tcp.connects).toHaveLength(0);
    expect(fakes.udp.sockets.map((s) => s.sends.length)).toEqual([3, 3]);
  });

  it('returns unverified (wait_disabled) with no probe when wait_for_s is 0', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['open'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    await expect(fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, live())).resolves.toEqual({
      kind: 'sent',
      state: 'unverified',
      unverifiedReason: 'wait_disabled',
    });
    expect(fakes.tcp.connects).toHaveLength(0);
  });
});

describe('LanService.wake — the closing probe when the window ends', () => {
  /** When the first packet goes out: after a refused pre-probe (2 ms) or a silent one (the 1.5 s timeout). */
  const firstPacketAt = (before: 'refused' | 'silent') =>
    START + (before === 'refused' ? LATENCY.refused : PROBE_TIMEOUT_MS);

  /** Wake gpu-box against a check port that answers `before` until `opensAfterMs` past the first packet. */
  async function wakeAgainst(
    waitForS: number,
    before: 'refused' | 'silent',
    opensAfterMs: number | 'never' = 'never',
  ) {
    const t0 = firstPacketAt(before);
    const behavior: TcpBehavior =
      opensAfterMs === 'never' ? before : { kind: 'opensAt', at: t0 + opensAfterMs, before };
    const fakes = setup({ tcp: { '192.0.2.50': [behavior] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), waitForS, live());
    return { ...fakes, result, t0 };
  }

  it.each([1, 2, 55])(
    'returns already_awake with wait_for_s %d after the one pre-probe, never polling',
    async (waitForS) => {
      const fakes = setup({ tcp: { '192.0.2.50': ['open'] } });
      const gpuBox = await profileOf(PROFILES.gpuBox);
      const result = await fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), waitForS, live());
      expect(result).toEqual({
        kind: 'sent',
        state: 'already_awake',
        probe: { address: '192.0.2.50', port: 22, attempts: 1, last_outcome: 'open' },
      });
      expect(fakes.tcp.connects).toHaveLength(1);
      expect(fakes.clock.now()).toBe(START + LATENCY.open + 2 * PACKET_SPACING_MS);
    },
  );

  it.each(['refused', 'silent'] as const)(
    'returns awake on the first in-window poll for a port that opens 20 ms after the first packet (%s before)',
    async (before) => {
      const { result, tcp, clock, t0 } = await wakeAgainst(55, before, 20);
      expect(result).toEqual({
        kind: 'sent',
        state: 'awake',
        probe: { address: '192.0.2.50', port: 22, attempts: 2, last_outcome: 'open' },
        timeToAnswerMs: 2004,
      });
      expect(tcp.connects.map((c) => c.at)).toEqual([START, t0 + 2000]);
      expect(clock.now()).toBe(t0 + 2004);
    },
  );

  // wait_for_s, the pre-probe's outcome, when the port opens (ms after the first packet,
  // or never), then the result: state, probes made, last outcome, return time and
  // time_to_answer_ms (both ms after the first packet). Windows 1 and 2 have no in-window
  // poll; 3 has one; 5 and 55 have several, the last cut off at the deadline.
  it.each([
    [1, 'refused', 20, 'awake', 2, 'open', 1004, 1004],
    [1, 'silent', 20, 'awake', 2, 'open', 1004, 1004],
    [1, 'refused', 1000, 'awake', 2, 'open', 1004, 1004],
    [1, 'silent', 1000, 'awake', 2, 'open', 1004, 1004],
    [1, 'refused', 'never', 'not_reachable', 2, 'refused', 1002, undefined],
    [1, 'silent', 'never', 'not_reachable', 2, 'no_answer', 2500, undefined],
    [2, 'refused', 20, 'awake', 2, 'open', 2004, 2004],
    [2, 'silent', 20, 'awake', 2, 'open', 2004, 2004],
    [2, 'refused', 2000, 'awake', 2, 'open', 2004, 2004],
    [2, 'silent', 2000, 'awake', 2, 'open', 2004, 2004],
    [2, 'refused', 'never', 'not_reachable', 2, 'refused', 2002, undefined],
    [2, 'silent', 'never', 'not_reachable', 2, 'no_answer', 3500, undefined],
    [3, 'refused', 2500, 'awake', 3, 'open', 3004, 3004],
    [3, 'silent', 2500, 'awake', 3, 'open', 3004, 3004],
    [3, 'refused', 3000, 'awake', 3, 'open', 3004, 3004],
    [3, 'silent', 3000, 'awake', 3, 'open', 3004, 3004],
    [3, 'refused', 'never', 'not_reachable', 3, 'refused', 3002, undefined],
    [3, 'silent', 'never', 'not_reachable', 3, 'no_answer', 4500, undefined],
    [5, 'refused', 4500, 'awake', 4, 'open', 5004, 5004],
    [5, 'silent', 4500, 'awake', 4, 'open', 5004, 5004],
    [5, 'refused', 5000, 'awake', 4, 'open', 5004, 5004],
    [5, 'silent', 5000, 'awake', 4, 'open', 5004, 5004],
    [5, 'refused', 'never', 'not_reachable', 4, 'refused', 5002, undefined],
    [5, 'silent', 'never', 'not_reachable', 4, 'no_answer', 6500, undefined],
    [55, 'refused', 54_500, 'awake', 29, 'open', 55_004, 55_004],
    [55, 'silent', 54_500, 'awake', 29, 'open', 55_004, 55_004],
    [55, 'refused', 55_000, 'awake', 29, 'open', 55_004, 55_004],
    [55, 'silent', 55_000, 'awake', 29, 'open', 55_004, 55_004],
    [55, 'refused', 'never', 'not_reachable', 29, 'refused', 55_002, undefined],
    [55, 'silent', 'never', 'not_reachable', 29, 'no_answer', 56_500, undefined],
  ] as const)(
    'wait_for_s %d, %s before, opens: %s → %s after %d probes (last %s), returning at t0 + %d ms',
    async (waitForS, before, opensAfterMs, state, attempts, lastOutcome, returnsAt, timeToAnswer) => {
      const { result, tcp, clock, t0 } = await wakeAgainst(waitForS, before, opensAfterMs);
      expect(result).toEqual({
        kind: 'sent',
        state,
        probe: { address: '192.0.2.50', port: 22, attempts, last_outcome: lastOutcome },
        ...(timeToAnswer !== undefined && { timeToAnswerMs: timeToAnswer }),
      });
      expect(clock.now()).toBe(t0 + returnsAt);
      // The last probe is the closing one: it starts when the window ends.
      expect(tcp.connects.at(-1)?.at).toBe(t0 + waitForS * 1000);
    },
  );

  it.each(
    Array.from({ length: 55 }, (_, i) => i + 1).flatMap((waitForS) => [
      [waitForS, 'refused'] as const,
      [waitForS, 'silent'] as const,
    ]),
  )(
    'wait_for_s %d against a %s port: polls every 2 s inside the window, probes once at its end, returns no earlier than the end and within wait_for_s + 3 s',
    async (waitForS, before) => {
      const { result, tcp, clock, t0 } = await wakeAgainst(waitForS, before);
      const deadline = t0 + waitForS * 1000;
      const inWindow = Array.from(
        { length: Math.ceil(waitForS / 2) - 1 },
        (_, i) => t0 + POLL_INTERVAL_MS * (i + 1),
      );
      expect(tcp.connects.map((c) => c.at)).toEqual([START, ...inWindow, deadline]);
      expect(result).toMatchObject({
        state: 'not_reachable',
        probe: {
          attempts: inWindow.length + 2,
          last_outcome: before === 'refused' ? 'refused' : 'no_answer',
        },
      });
      expect(clock.now()).toBeGreaterThanOrEqual(deadline);
      expect(clock.now() - START).toBeLessThanOrEqual(waitForS * 1000 + 2 * PROBE_TIMEOUT_MS);
      // The closing probe gets the whole probe timeout, never a clamped one.
      if (before === 'silent') {
        expect(clock.sleeps.at(-1)).toEqual({ at: deadline, ms: PROBE_TIMEOUT_MS });
      }
    },
  );
});

describe('LanService.wake — cancellation', () => {
  async function cancelAt(atMs: number) {
    const fakes = setup({ tcp: { '192.0.2.50': ['silent'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const controller = new AbortController();
    fakes.clock.schedule(atMs, () => controller.abort());
    const outcome = await fakes.lan
      .wake(gpuBox, fakes.segmentOf(gpuBox), 30, controller.signal)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    return { ...fakes, outcome };
  }

  it('rejects when aborted during a poll wait, with the UDP socket already closed', async () => {
    const t0 = PROBE_TIMEOUT_MS;
    const { outcome, udp, tcp, clock } = await cancelAt(t0 + 1300);
    expect(outcome).toMatchObject({ error: { name: 'AbortError' } });
    expect(udp.only.sends).toHaveLength(3);
    expect(udp.only.ops.filter((op) => op === 'close')).toHaveLength(1);
    expect(tcp.connects).toHaveLength(1);
    expect(tcp.connects.every((c) => c.socket.destroyed)).toBe(true);
    expect(clock.now()).toBe(START + t0 + 1300);
    expect(clock.pending).toBe(0);
  });

  it('rejects when aborted during an in-flight poll, destroying that probe socket', async () => {
    const t0 = PROBE_TIMEOUT_MS;
    const { outcome, udp, tcp, clock } = await cancelAt(t0 + POLL_INTERVAL_MS + 700);
    expect(outcome).toMatchObject({ error: { name: 'AbortError' } });
    expect(udp.only.closed).toBe(true);
    expect(tcp.connects).toHaveLength(2);
    expect(tcp.connects.every((c) => c.socket.destroyCount === 1)).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('rejects between packets, leaving the packets already sent sent and the socket closed', async () => {
    const t0 = PROBE_TIMEOUT_MS;
    const { outcome, udp } = await cancelAt(t0 + 200);
    expect(outcome).toMatchObject({ error: { name: 'AbortError' } });
    expect(udp.only.sends).toHaveLength(1);
    expect(udp.only.ops.slice(-2)).toEqual(['removeListener', 'close']);
  });

  it('rejects when aborted while waiting for the closing probe, starting no further probe', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['refused'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const controller = new AbortController();
    const t0 = LATENCY.refused;
    // The t0 + 4 s poll is refused at once; the closing probe is due at t0 + 5 s.
    fakes.clock.schedule(t0 + 4500, () => controller.abort());
    await expect(
      fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 5, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakes.tcp.connects.map((c) => c.at - START)).toEqual([0, t0 + 2000, t0 + 4000]);
    expect(fakes.tcp.connects.every((c) => c.socket.destroyCount === 1)).toBe(true);
    expect(fakes.udp.only.closed).toBe(true);
    expect(fakes.clock.now()).toBe(START + t0 + 4500);
    expect(fakes.clock.pending).toBe(0);
  });

  it('rejects when aborted during the closing probe, destroying its socket', async () => {
    const fakes = setup({ tcp: { '192.0.2.50': ['silent'] } });
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const controller = new AbortController();
    const t0 = PROBE_TIMEOUT_MS;
    fakes.clock.schedule(t0 + 5700, () => controller.abort());
    await expect(
      fakes.lan.wake(gpuBox, fakes.segmentOf(gpuBox), 5, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakes.tcp.connects).toHaveLength(4);
    expect(fakes.tcp.connects.at(-1)?.at).toBe(START + t0 + 5000);
    expect(fakes.tcp.connects.every((c) => c.socket.destroyCount === 1)).toBe(true);
    expect(fakes.clock.now()).toBe(START + t0 + 5700);
    expect(fakes.clock.pending).toBe(0);
  });

  it('rejects during the pre-probe without opening a UDP socket', async () => {
    const { outcome, udp, tcp } = await cancelAt(300);
    expect(outcome).toMatchObject({ error: { name: 'AbortError' } });
    expect(udp.sockets).toHaveLength(0);
    expect(tcp.connects[0]?.socket.destroyed).toBe(true);
  });

  it.each([
    ['the probe path', PROFILES.gpuBox, 30],
    ['wait_disabled', PROFILES.gpuBox, 0],
    ['no_address', PROFILES.printer, 30],
    ['no_address with wait_for_s 0', PROFILES.printer, 0],
  ] as const)(
    'sends nothing and opens no socket on %s when the signal is already aborted',
    async (_label, entry, waitForS) => {
      const fakes = setup({ tcp: { '192.0.2.50': ['open'] } });
      const profile = await profileOf(entry);
      const controller = new AbortController();
      controller.abort();
      await expect(
        fakes.lan.wake(profile, fakes.segmentOf(profile), waitForS, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(fakes.udp.sockets).toHaveLength(0);
      expect(fakes.tcp.connects).toHaveLength(0);
    },
  );

  it('sends nothing when cancellation lands while the socket binds, and still closes it', async () => {
    const fakes = setup();
    const gpuBox = await profileOf(PROFILES.gpuBox);
    const controller = new AbortController();
    const lan = new LanService({
      ...fakes.deps,
      createUdpSocket: (options) => {
        const socket = fakes.udp.createUdpSocket(options);
        controller.abort();
        return socket;
      },
    });
    await expect(
      lan.wake(gpuBox, fakes.segmentOf(gpuBox), 0, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakes.udp.only.sends).toHaveLength(0);
    expect(fakes.udp.only.closed).toBe(true);
  });
});

describe('getLanService', () => {
  it('throws until initLanService() has run', async () => {
    vi.resetModules();
    const module = await import('@/services/lan/lan-service.js');
    expect(() => module.getLanService()).toThrow(/not initialized/);
    module.initLanService(createLanFakes().deps);
    expect(module.getLanService()).toBeInstanceOf(module.LanService);
  });
});
