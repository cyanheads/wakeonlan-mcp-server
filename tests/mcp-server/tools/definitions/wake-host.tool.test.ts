/**
 * @fileoverview wol_wake_host through the handler and the production contract
 * path (`runToolContract`) on faked sockets and a virtual clock: input bounds,
 * every result state on both surfaces, every declared error reason with its
 * data and recovery, cancellation, and format() safety.
 * @module tests/mcp-server/tools/definitions/wake-host.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { wolCheckHost } from '@/mcp-server/tools/definitions/check-host.tool.js';
import { wolWakeHost } from '@/mcp-server/tools/definitions/wake-host.tool.js';
import { NO_PROFILES_HINT } from '@/mcp-server/tools/host-alias.js';
import { refusedGuidance } from '@/mcp-server/tools/text.js';
import { PACKET_COUNT, POLL_INTERVAL_MS, PROBE_TIMEOUT_MS } from '@/services/lan/lan-service.js';
import {
  blocksText,
  contentText,
  EMPTY_TABLE,
  errorOf,
  installHosts,
  installNoHosts,
  LINE_BREAKS,
  magicPacketHex,
  PROFILES,
  renderedLines,
  SECUREON,
  structuredOf,
  v4,
} from '../../../helpers/fixtures.js';
import {
  coded,
  installLanFakes,
  LATENCY,
  type LanFakeOptions,
} from '../../../helpers/lan-fakes.js';

type WakeInput = z.input<typeof wolWakeHost.input>;
type WakeOutput = z.output<typeof wolWakeHost.output>;

const recoveryFor = (reason: string) =>
  wolWakeHost.errors?.find((entry) => entry.reason === reason)?.recovery;

/** Run through the production contract path: schema, handler, output parse, format(). */
async function wake(input: WakeInput, lan: LanFakeOptions = {}) {
  const fakes = installLanFakes(lan);
  const result = await runToolContract(wolWakeHost, input);
  return { fakes, result, structured: structuredOf(result), text: contentText(result) };
}

/** Call the handler directly and return what it threw. */
async function wakeFailure(input: WakeInput, lan: LanFakeOptions = {}) {
  const fakes = installLanFakes(lan);
  const ctx = createMockContext({ errors: wolWakeHost.errors });
  try {
    await wolWakeHost.handler(wolWakeHost.input.parse(input), ctx);
  } catch (error) {
    return { fakes, error: error as McpError };
  }
  throw new Error('Expected wol_wake_host to fail');
}

beforeEach(async () => {
  await installHosts(Object.values(PROFILES));
});

describe('wol_wake_host — input', () => {
  const parse = (input: unknown) => wolWakeHost.input.safeParse(input);

  it('defaults wait_for_s to 30 when omitted or blank (form clients send "")', () => {
    expect(parse({ alias: 'gpu-box' }).data).toEqual({ alias: 'gpu-box', wait_for_s: 30 });
    expect(parse({ alias: 'gpu-box', wait_for_s: '' }).data).toEqual({
      alias: 'gpu-box',
      wait_for_s: 30,
    });
  });

  it.each([0, 1, 30, 55])('accepts wait_for_s %d', (wait) => {
    expect(parse({ alias: 'gpu-box', wait_for_s: wait }).success).toBe(true);
  });

  it.each([-1, 56, 2.5, '30', null, Number.NaN])('rejects wait_for_s %j', (wait) => {
    expect(parse({ alias: 'gpu-box', wait_for_s: wait }).success).toBe(false);
  });

  it.each(['gpu-box', 'A', '0', 'nas.home_1-x', 'a'.repeat(64)])(
    'accepts the alias %j',
    (alias) => {
      expect(parse({ alias }).success).toBe(true);
    },
  );

  it.each([
    '',
    ' gpu-box',
    'gpu-box ',
    'gpu box',
    '-gpu',
    '.gpu',
    '_gpu',
    'gpu/box',
    '../etc/passwd',
    'gpu\nbox',
    'ñas',
    'a'.repeat(65),
  ])('rejects the alias %j', (alias) => {
    expect(parse({ alias }).success).toBe(false);
  });

  it('rejects a missing alias', () => {
    expect(parse({}).success).toBe(false);
  });

  it.each([
    ['mac', '00:00:5e:00:53:99'],
    ['broadcast', '255.255.255.255'],
    ['address', '192.0.2.99'],
    ['wol_port', 7],
    ['check_port', 3389],
  ])('rejects a raw %s alongside the alias: targets come only from profiles', (key, value) => {
    expect(Object.keys(wolWakeHost.input.shape)).toEqual(['alias', 'wait_for_s']);
    expect(parse({ alias: 'gpu-box', [key]: value }).success).toBe(false);
  });

  it('returns InvalidParams for a malformed alias or wait on the contract path, touching no socket', async () => {
    for (const input of [{ alias: 'gpu box' }, { alias: 'gpu-box', wait_for_s: 90 }]) {
      const { result, fakes } = await wake(input);
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(fakes.udp.sockets).toHaveLength(0);
      expect(fakes.tcp.connects).toHaveLength(0);
    }
  });
});

describe('wol_wake_host — result states on both surfaces', () => {
  it('already_awake: the pre-probe answered; packets still sent, no polling', async () => {
    const { structured, text, fakes } = await wake(
      { alias: 'gpu-box' },
      { tcp: { '192.0.2.50': ['open'] } },
    );
    expect(structured).toEqual({
      alias: 'gpu-box',
      mac: '00:00:5e:00:53:01',
      state: 'already_awake',
      packets_sent: PACKET_COUNT,
      broadcast: '192.0.2.255',
      wol_port: 9,
      interface: 'en0',
      local_address: '192.0.2.10',
      secureon_set: false,
      probe: { address: '192.0.2.50', port: 22, attempts: 1, last_outcome: 'open' },
      elapsed_ms: LATENCY.open + 1000,
    });
    expect(structured).not.toHaveProperty('secureon');
    expect(fakes.udp.only.sends).toHaveLength(3);
    expect(fakes.tcp.connects).toHaveLength(1);

    expect(text).toContain('## gpu-box: already_awake');
    for (const value of [
      '192.0.2.50:22',
      '192.0.2.255:9',
      'en0',
      '192.0.2.10',
      'secureon_set: no',
      '00:00:5e:00:53:01',
      `${LATENCY.open + 1000} ms`,
    ]) {
      expect(text).toContain(value);
    }
  });

  it('awake: answers within the window, reporting time_to_answer_ms from the first packet', async () => {
    const { structured, text } = await wake(
      { alias: 'gpu-box', wait_for_s: 30 },
      { tcp: { '192.0.2.50': ['silent', 'refused', 'open'] } },
    );
    const timeToAnswer = 2 * POLL_INTERVAL_MS + LATENCY.open;
    expect(structured).toMatchObject({
      state: 'awake',
      probe: { address: '192.0.2.50', port: 22, attempts: 3, last_outcome: 'open' },
      time_to_answer_ms: timeToAnswer,
      elapsed_ms: PROBE_TIMEOUT_MS + timeToAnswer,
    });
    expect(structured).not.toHaveProperty('guidance');
    expect(structured).not.toHaveProperty('unverified_reason');
    expect(text).toContain('## gpu-box: awake');
    expect(text).toContain(`${timeToAnswer} ms`);
    expect(text).toContain('3 attempts');
  });

  it('not_reachable (no_answer): guidance names the broadcast, the probe target, and the window', async () => {
    const { structured, text } = await wake(
      { alias: 'gpu-box', wait_for_s: 5 },
      { tcp: { '192.0.2.50': ['silent'] } },
    );
    expect(structured).toMatchObject({
      state: 'not_reachable',
      probe: { attempts: 3, last_outcome: 'no_answer' },
      elapsed_ms: PROBE_TIMEOUT_MS + 5000,
    });
    expect(structured).not.toHaveProperty('time_to_answer_ms');
    const guidance = String((structured as { guidance?: string }).guidance);
    expect(guidance).toContain('192.0.2.255:9');
    expect(guidance).toContain('192.0.2.50:22');
    expect(guidance).toContain('5 s');
    expect(guidance).toContain('wol_check_host');
    expect(guidance).not.toBe(refusedGuidance('192.0.2.50', 22));
    // content[] carries the guidance as a blockquote.
    expect(text).toContain(`> ${guidance}`);
  });

  it('not_reachable (refused): guidance says the machine is on and nothing listens on the port', async () => {
    const { structured } = await wake(
      { alias: 'nas', wait_for_s: 5 },
      { tcp: { 'nas.home.arpa': ['refused'] } },
    );
    expect(structured).toMatchObject({
      state: 'not_reachable',
      probe: { address: 'nas.home.arpa', port: 445, last_outcome: 'refused' },
      guidance: refusedGuidance('nas.home.arpa', 445),
    });
  });

  it('brackets an IPv6 probe address before the port on both surfaces', async () => {
    const { structured, text } = await wake(
      { alias: 'v6-box', wait_for_s: 3 },
      { tcp: { '2001:db8::50': ['silent'] } },
    );
    expect(structured).toMatchObject({
      state: 'not_reachable',
      wol_port: 7,
      probe: { address: '2001:db8::50', port: 22 },
    });
    expect(String((structured as { guidance?: string }).guidance)).toContain('[2001:db8::50]:22');
    expect(text).toContain('[2001:db8::50]:22');
  });

  it('unverified (wait_disabled): wait_for_s 0 sends and returns without any probe', async () => {
    const { structured, text, fakes } = await wake(
      { alias: 'gpu-box', wait_for_s: 0 },
      { tcp: { '192.0.2.50': ['open'] } },
    );
    expect(structured).toMatchObject({
      state: 'unverified',
      unverified_reason: 'wait_disabled',
      packets_sent: 3,
      elapsed_ms: 1000,
    });
    expect(structured).not.toHaveProperty('probe');
    expect(String((structured as { guidance?: string }).guidance)).toContain('wol_check_host');
    expect(fakes.tcp.connects).toHaveLength(0);
    expect(text).toContain('wait_disabled');
  });

  it('unverified (no_address): outranks wait_disabled, and points at the host-profiles reference', async () => {
    for (const wait_for_s of [30, 0]) {
      const { structured, fakes } = await wake({ alias: 'printer', wait_for_s });
      expect(structured).toMatchObject({ state: 'unverified', unverified_reason: 'no_address' });
      expect(structured).not.toHaveProperty('probe');
      expect(String((structured as { guidance?: string }).guidance)).toContain('host-profiles');
      expect(fakes.tcp.connects).toHaveLength(0);
      expect(fakes.udp.only.sends).toHaveLength(3);
    }
  });

  it('resolves the alias case-insensitively and reports the canonical one', async () => {
    const { structured, fakes } = await wake(
      { alias: 'NAS', wait_for_s: 0 },
      { tcp: { 'nas.home.arpa': ['open'] } },
    );
    expect(structured).toMatchObject({ alias: 'nas', mac: '00:00:5e:00:53:02' });
    expect(fakes.udp.only.sends[0]?.address).toBe('192.0.2.255');
  });

  it("probes the profile's own address and check_port", async () => {
    const { fakes } = await wake({ alias: 'nas' }, { tcp: { 'nas.home.arpa': ['open'] } });
    expect(fakes.tcp.connects.map((c) => `${c.host}:${c.port}`)).toEqual(['nas.home.arpa:445']);
  });
});

describe('wol_wake_host — time_to_answer_ms', () => {
  const pollS = POLL_INTERVAL_MS / 1000;

  it("describes the connecting poll's time as an upper bound, not the moment the port came up", () => {
    const description = wolWakeHost.output.shape.time_to_answer_ms.description ?? '';
    expect(description).toContain('confirmation poll that connected');
    expect(description).toContain(`every ${pollS} seconds`);
    expect(description).toContain('upper bound');
    expect(description).not.toContain('to the check port answering');
  });

  it('renders it in content[] as the poll that connected, flagged as an upper bound', async () => {
    const { structured, text } = await wake(
      { alias: 'gpu-box', wait_for_s: 10 },
      { tcp: { '192.0.2.50': ['silent', 'open'] } },
    );
    const connectedAt = POLL_INTERVAL_MS + LATENCY.open;
    expect(structured).toMatchObject({ state: 'awake', time_to_answer_ms: connectedAt });
    expect(text).toContain(
      `poll connected ${connectedAt} ms after the first packet (an upper bound on when the port came up; polls run every ${pollS} s)`,
    );
    expect(text).not.toContain(`answered ${connectedAt} ms`);
  });
});

describe('wol_wake_host — SecureOn', () => {
  it('reports only that a password was appended, never the password, on either surface or in logs', async () => {
    const fakes = installLanFakes({ tcp: { 'nas.home.arpa': ['open'] } });
    const ctx = createMockContext({ errors: wolWakeHost.errors });
    const output = await wolWakeHost.handler(wolWakeHost.input.parse({ alias: 'nas' }), ctx);
    const contract = await runToolContract(wolWakeHost, { alias: 'nas' });

    expect(output.secureon_set).toBe(true);
    expect(contract.structuredContent).toMatchObject({ secureon_set: true });
    expect(contentText(contract)).toContain('secureon_set: yes');
    const surfaces = [
      JSON.stringify(output),
      JSON.stringify(contract),
      JSON.stringify((ctx.log as MockContextLogger).calls),
    ].map((s) => s.toLowerCase());
    for (const surface of surfaces) {
      for (const form of [SECUREON.typed, SECUREON.stored, SECUREON.stored.replaceAll(':', '')]) {
        expect(surface).not.toContain(form.toLowerCase());
      }
    }
    // It is still on the wire, appended to the packet.
    expect(
      fakes.udp.sockets[0]?.sends[0]?.bytes.equals(
        magicPacketHex('00005e005302', SECUREON.stored.replaceAll(':', '')),
      ),
    ).toBe(true);
  });
});

describe('wol_wake_host — unknown_host', () => {
  it('names the submitted alias and lists the configured ones, with the contract recovery', async () => {
    const { error, fakes } = await wakeFailure({ alias: 'gpu-box2' });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'unknown_host',
        alias: 'gpu-box2',
        configured_aliases: Object.values(PROFILES).map((p) => p.alias),
        configured_count: Object.values(PROFILES).length,
        recovery: { hint: recoveryFor('unknown_host') },
      },
    });
    expect(error.message).toContain('gpu-box2');
    for (const profile of Object.values(PROFILES)) expect(error.message).toContain(profile.alias);
    expect(fakes.udp.sockets).toHaveLength(0);
    expect(fakes.interfaceReads).toBe(0);
  });

  it('lists only the first 20 of more configured aliases, and counts all of them', async () => {
    const aliases = Array.from({ length: 24 }, (_, i) => `host-${String(i + 1).padStart(2, '0')}`);
    await installHosts(aliases.map((alias) => ({ ...PROFILES.gpuBox, alias })));
    const { error } = await wakeFailure({ alias: 'missing' });
    expect(error.data).toMatchObject({
      reason: 'unknown_host',
      configured_aliases: aliases.slice(0, 20),
      configured_count: 24,
    });
    expect(error.message).toContain('host-20');
    expect(error.message).not.toContain('host-21');
  });

  it('lists exactly 20 configured aliases in full', async () => {
    const aliases = Array.from({ length: 20 }, (_, i) => `h${i + 1}`);
    await installHosts(aliases.map((alias) => ({ ...PROFILES.gpuBox, alias })));
    const { error } = await wakeFailure({ alias: 'missing' });
    expect(error.data).toMatchObject({ configured_aliases: aliases, configured_count: 20 });
    expect(error.message).toContain('h20');
  });

  it('switches the recovery to the setup hint when no profiles are configured', async () => {
    installNoHosts();
    const { error } = await wakeFailure({ alias: 'gpu-box' });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'unknown_host',
        configured_aliases: [],
        configured_count: 0,
        recovery: { hint: NO_PROFILES_HINT },
      },
    });
  });

  it('returns the dual-surface envelope with the reason and recovery in content[]', async () => {
    const { result } = await wake({ alias: 'gpu-box2' });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'unknown_host' },
    });
    expect(contentText(result)).toMatch(/^Error: /);
    expect(contentText(result)).toContain('reason unknown_host');
    expect(contentText(result)).toContain(String(recoveryFor('unknown_host')));
  });
});

describe('wol_wake_host — off_segment', () => {
  it('refuses a host whose broadcast cannot be derived, naming the address and the subnets compared', async () => {
    const { error, fakes } = await wakeFailure({ alias: 'cabin-pc' });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: {
        reason: 'off_segment',
        alias: 'cabin-pc',
        local_subnets: [
          { interface: 'lo0', cidr: '127.0.0.1/8' },
          { interface: 'en0', cidr: '192.0.2.10/24' },
        ],
        recovery: { hint: recoveryFor('off_segment') },
      },
    });
    expect(error.data).not.toHaveProperty('broadcast');
    expect(error.message).toContain('198.51.100.20');
    expect(error.message).toContain('en0 192.0.2.10/24');
    expect(fakes.udp.sockets).toHaveLength(0);
    expect(fakes.tcp.connects).toHaveLength(0);
  });

  it('refuses a configured broadcast no local interface has, naming it', async () => {
    const { error } = await wakeFailure({ alias: 'lab' });
    expect(error.data).toMatchObject({
      reason: 'off_segment',
      alias: 'lab',
      broadcast: '203.0.113.255',
    });
    expect(error.message).toContain('203.0.113.255');
  });

  it('refuses every host when the machine has no interfaces', async () => {
    const { error } = await wakeFailure({ alias: 'gpu-box' }, { interfaces: EMPTY_TABLE });
    expect(error.data).toMatchObject({ reason: 'off_segment', local_subnets: [] });
  });

  it.each(LINE_BREAKS)(
    'flattens %s in interface names on both error surfaces, keeping data verbatim',
    async (_name, br) => {
      const name = `en0${br}## Injected`;
      const { result } = await wake(
        { alias: 'lab' },
        { interfaces: { [name]: [v4('192.0.2.10', '255.255.255.0', '192.0.2.10/24')] } },
      );
      const error = errorOf(result);
      expect(renderedLines(error.message)).toHaveLength(1);
      expect(error.message).toContain('en0 ## Injected 192.0.2.10/24');
      expect(error.data).toMatchObject({
        local_subnets: [{ interface: name, cidr: '192.0.2.10/24' }],
      });
      const text = contentText(result);
      expect(text).toContain('en0 ## Injected 192.0.2.10/24');
      expect(renderedLines(text).some((line) => line.startsWith('## Injected'))).toBe(false);
    },
  );

  it('re-resolves per call, so a host goes on-segment once the machine joins its subnet', async () => {
    const lab = { interfaces: { en5: [v4('203.0.113.4', '255.255.255.0', '203.0.113.4/24')] } };
    const { structured } = await wake({ alias: 'lab', wait_for_s: 0 }, lab);
    expect(structured).toMatchObject({
      state: 'unverified',
      interface: 'en5',
      local_address: '203.0.113.4',
    });
  });
});

describe('wol_wake_host — socket_error', () => {
  it.each([
    ['bind', { bindError: coded('EADDRNOTAVAIL') }, 0, 'EADDRNOTAVAIL'],
    ['set_broadcast', { setBroadcastError: coded('EACCES') }, 0, 'EACCES'],
    ['send', { failSend: { nth: 1, error: coded('EACCES') } }, 0, 'EACCES'],
    ['send', { failSend: { nth: 2, error: coded('ENETUNREACH') } }, 1, 'ENETUNREACH'],
    ['send', { failSend: { nth: 3, error: coded('ENOBUFS') } }, 2, 'ENOBUFS'],
  ] as const)('reports stage %s with %j', async (stage, udp, packetsSent, code) => {
    const { error, fakes } = await wakeFailure({ alias: 'gpu-box', wait_for_s: 0 }, { udp });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'socket_error',
        retryable: true,
        alias: 'gpu-box',
        stage,
        packets_sent: packetsSent,
        packets_planned: PACKET_COUNT,
        code,
        recovery: { hint: recoveryFor('socket_error') },
      },
    });
    expect(error.message).toContain(stage);
    expect(error.message).toContain(code);
    expect(fakes.udp.only.closed).toBe(true);
  });

  it('fails the call on a partial send even after the host answered the pre-probe', async () => {
    const { error } = await wakeFailure(
      { alias: 'gpu-box' },
      { tcp: { '192.0.2.50': ['open'] }, udp: { failSend: { nth: 2, error: coded('EPERM') } } },
    );
    expect(error.data).toMatchObject({ reason: 'socket_error', stage: 'send', packets_sent: 1 });
  });

  it.each([
    ['a profile with no address', { alias: 'printer' }, 0],
    ['the probe path after a silent pre-probe', { alias: 'gpu-box' }, 1],
  ] as const)(
    'fails with socket_error on %s and probes nothing after the failed send',
    async (_label, input, probes) => {
      const { error, fakes } = await wakeFailure(input, {
        tcp: { '192.0.2.50': ['silent'] },
        udp: { failSend: { nth: 2, error: coded('ENETUNREACH') } },
      });
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'socket_error', stage: 'send', packets_sent: 1, code: 'ENETUNREACH' },
      });
      expect(fakes.tcp.connects).toHaveLength(probes);
      expect(fakes.udp.only.closed).toBe(true);
    },
  );

  it('omits code from data and message when the failure carries none', async () => {
    const { error } = await wakeFailure(
      { alias: 'gpu-box', wait_for_s: 0 },
      { udp: { failSend: { nth: 1, error: new Error('no errno') } } },
    );
    expect(error.data).toMatchObject({ reason: 'socket_error', stage: 'send', packets_sent: 0 });
    expect(error.data).not.toHaveProperty('code');
    expect(error.message).not.toContain('undefined');
  });

  it('swaps in the macOS Local Network hint on darwin only', async () => {
    const udp = { bindError: coded('EHOSTUNREACH') };
    const darwin = await wakeFailure(
      { alias: 'gpu-box', wait_for_s: 0 },
      { udp, platform: 'darwin' },
    );
    const hint = (darwin.error.data as { recovery?: { hint?: string } }).recovery?.hint;
    expect(hint).not.toBe(recoveryFor('socket_error'));
    expect(hint).toContain('Local Network');

    for (const platform of ['linux', 'win32'] as const) {
      const other = await wakeFailure({ alias: 'gpu-box', wait_for_s: 0 }, { udp, platform });
      expect(other.error.data).toMatchObject({ recovery: { hint: recoveryFor('socket_error') } });
    }
  });

  it('marks the envelope retryable in content[] too', async () => {
    const { result } = await wake(
      { alias: 'gpu-box', wait_for_s: 0 },
      { udp: { bindError: coded('EADDRNOTAVAIL') } },
    );
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'socket_error', retryable: true },
    });
    expect(contentText(result)).toContain('reason socket_error');
    expect(contentText(result)).toContain('retryable');
  });
});

describe('wol_wake_host — wake_in_progress', () => {
  /**
   * Start a wake through the handler without awaiting it. The handler claims
   * the host before its first await, so a call made right after sees it busy.
   */
  function startWake(input: WakeInput, signal = new AbortController().signal) {
    const ctx = createMockContext({ errors: wolWakeHost.errors, signal });
    return wolWakeHost.handler(wolWakeHost.input.parse(input), ctx);
  }

  it('refuses a second wake of a host while the first runs, on both surfaces, touching no socket', async () => {
    const fakes = installLanFakes({ tcp: { '192.0.2.50': ['open'] } });
    const first = startWake({ alias: 'gpu-box' });
    const second = await runToolContract(wolWakeHost, { alias: 'gpu-box' });

    expect(second.isError).toBe(true);
    const error = errorOf(second);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: {
        reason: 'wake_in_progress',
        retryable: true,
        alias: 'gpu-box',
        recovery: { hint: recoveryFor('wake_in_progress') },
      },
    });
    expect(error.message).toContain('gpu-box');
    const text = contentText(second);
    expect(text).toMatch(/^Error: /);
    expect(text).toContain(`Recovery: ${recoveryFor('wake_in_progress')}`);
    expect(text).toContain('reason wake_in_progress · retryable');

    await expect(first).resolves.toMatchObject({ state: 'already_awake' });
    expect(fakes.udp.sockets).toHaveLength(1);
    expect(fakes.tcp.connects).toHaveLength(1);
  });

  it('treats the alias case-insensitively: GPU-BOX is busy while gpu-box wakes', async () => {
    installLanFakes({ tcp: { '192.0.2.50': ['open'] } });
    const first = startWake({ alias: 'gpu-box' });
    await expect(startWake({ alias: 'GPU-BOX' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'wake_in_progress', alias: 'gpu-box' },
    });
    await first;
  });

  it('lets a wake of another host run alongside', async () => {
    const fakes = installLanFakes({ tcp: { '192.0.2.50': ['open'], 'nas.home.arpa': ['open'] } });
    const first = startWake({ alias: 'gpu-box' });
    const second = await runToolContract(wolWakeHost, { alias: 'nas' });
    expect(structuredOf(second)).toMatchObject({ alias: 'nas', state: 'already_awake' });
    await expect(first).resolves.toMatchObject({ alias: 'gpu-box', state: 'already_awake' });
    expect(fakes.udp.sockets).toHaveLength(2);
  });

  it('leaves wol_check_host of the same host free to run', async () => {
    installLanFakes({ tcp: { '192.0.2.50': ['open'] } });
    const first = startWake({ alias: 'gpu-box' });
    const check = await runToolContract(wolCheckHost, { alias: 'gpu-box' });
    expect(structuredOf(check)).toMatchObject({ alias: 'gpu-box', outcome: 'open' });
    await first;
  });

  it('frees the host once a wake returns', async () => {
    installLanFakes({ tcp: { '192.0.2.50': ['open'] } });
    await startWake({ alias: 'gpu-box' });
    const again = await runToolContract(wolWakeHost, { alias: 'gpu-box' });
    expect(structuredOf(again)).toMatchObject({ state: 'already_awake' });
  });

  it('frees the host once a wake fails', async () => {
    const fakes = installLanFakes({ udp: { failSend: { nth: 2, error: coded('ENETUNREACH') } } });
    await expect(startWake({ alias: 'gpu-box', wait_for_s: 0 })).rejects.toMatchObject({
      data: { reason: 'socket_error' },
    });
    const again = await runToolContract(wolWakeHost, { alias: 'gpu-box', wait_for_s: 0 });
    expect(errorOf(again).data).toMatchObject({ reason: 'socket_error' });
    expect(fakes.udp.sockets).toHaveLength(2);
  });

  it('frees the host once a wake is cancelled', async () => {
    const fakes = installLanFakes({ tcp: { '192.0.2.50': ['silent'] } });
    const controller = new AbortController();
    fakes.clock.schedule(PROBE_TIMEOUT_MS + 1300, () => controller.abort());
    await expect(startWake({ alias: 'gpu-box' }, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    const again = await runToolContract(wolWakeHost, { alias: 'gpu-box', wait_for_s: 0 });
    expect(structuredOf(again)).toMatchObject({ state: 'unverified' });
  });
});

describe('wol_wake_host — cancellation', () => {
  it('rejects with an abort mid-poll, leaving the UDP socket closed and every probe socket destroyed', async () => {
    const fakes = installLanFakes({ tcp: { '192.0.2.50': ['silent'] } });
    const controller = new AbortController();
    fakes.clock.schedule(PROBE_TIMEOUT_MS + 1300, () => controller.abort());
    const ctx = createMockContext({ errors: wolWakeHost.errors, signal: controller.signal });
    await expect(
      wolWakeHost.handler(wolWakeHost.input.parse({ alias: 'gpu-box' }), ctx),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakes.udp.only.sends).toHaveLength(3);
    expect(fakes.udp.only.closed).toBe(true);
    expect(fakes.tcp.connects.every((c) => c.socket.destroyed)).toBe(true);
  });

  it.each([
    ['the probe path', { alias: 'gpu-box' }],
    ['wait_disabled', { alias: 'gpu-box', wait_for_s: 0 }],
    ['no_address', { alias: 'printer' }],
  ] as const)(
    'sends no packet and opens no socket when the call arrives already cancelled (%s)',
    async (_label, input) => {
      const fakes = installLanFakes({ tcp: { '192.0.2.50': ['open'] } });
      const controller = new AbortController();
      controller.abort();
      const result = await runToolContract(wolWakeHost, input, {
        context: { signal: controller.signal },
      });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(fakes.udp.sockets).toHaveLength(0);
      expect(fakes.tcp.connects).toHaveLength(0);
    },
  );

  it('reports RequestCancelled on the contract path', async () => {
    const controller = new AbortController();
    const fakes = installLanFakes({ tcp: { '192.0.2.50': ['silent'] } });
    fakes.clock.schedule(PROBE_TIMEOUT_MS + POLL_INTERVAL_MS + 700, () => controller.abort());
    const result = await runToolContract(
      wolWakeHost,
      { alias: 'gpu-box' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

describe('wol_wake_host — format()', () => {
  const render = (output: WakeOutput) => blocksText(wolWakeHost.format?.(output) ?? []);
  const sent = {
    alias: 'gpu-box',
    mac: '00:00:5e:00:53:01',
    packets_sent: 3,
    broadcast: '192.0.2.255',
    wol_port: 9,
    interface: 'en0',
    local_address: '192.0.2.10',
    secureon_set: true,
    elapsed_ms: 6500,
  } as const;
  const probe = {
    address: '192.0.2.50',
    port: 22,
    attempts: 3,
    last_outcome: 'no_answer',
  } as const;

  it('renders every output field of a not_reachable result, guidance as a blockquote', () => {
    const text = render({
      ...sent,
      state: 'not_reachable',
      probe,
      guidance: 'First line.\nSecond line.',
    });
    for (const value of [
      '## gpu-box: not_reachable',
      '00:00:5e:00:53:01',
      '192.0.2.255:9',
      'en0',
      '192.0.2.10',
      '192.0.2.50:22',
      'no_answer',
      '6500 ms',
    ]) {
      expect(text).toContain(value);
    }
    expect(text).toContain('> First line.\n> Second line.');
  });

  it('renders time_to_answer_ms for awake and unverified_reason for unverified', () => {
    const awake = render({
      ...sent,
      state: 'awake',
      probe: { ...probe, last_outcome: 'open' },
      time_to_answer_ms: 4004,
    });
    expect(awake).toContain('4004 ms');
    const unverified = render({
      ...sent,
      state: 'unverified',
      unverified_reason: 'no_address',
      guidance: 'Add an address.',
    });
    expect(unverified).toContain('no_address');
  });

  it('renders secureon_set as yes or no under its own name', () => {
    const yes = render({ ...sent, state: 'already_awake', secureon_set: true });
    const no = render({ ...sent, state: 'already_awake', secureon_set: false });
    expect(yes).toContain('secureon_set: yes');
    expect(no).toContain('secureon_set: no');
    expect(no).not.toContain('yes');
  });

  it.each(LINE_BREAKS)(
    'flattens %s in an OS-supplied interface name so it cannot start a new heading',
    (_name, br) => {
      const text = render({ ...sent, state: 'already_awake', interface: `en0${br}## Injected` });
      expect(text).toContain('en0 ## Injected');
      expect(renderedLines(text).some((line) => line.startsWith('## Injected'))).toBe(false);
    },
  );
});
