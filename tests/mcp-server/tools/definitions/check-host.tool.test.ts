/**
 * @fileoverview wol_check_host on faked sockets and a virtual clock: open,
 * refused, silent, and unreachable outcomes on both surfaces, darwin guidance
 * through the injected platform, and the unknown_host / no_address reasons.
 * @module tests/mcp-server/tools/definitions/check-host.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { wolCheckHost } from '@/mcp-server/tools/definitions/check-host.tool.js';
import { NO_PROFILES_HINT } from '@/mcp-server/tools/host-alias.js';
import { refusedGuidance } from '@/mcp-server/tools/text.js';
import { PROBE_TIMEOUT_MS } from '@/services/lan/lan-service.js';
import {
  blocksText,
  contentText,
  errorOf,
  installHosts,
  installNoHosts,
  PROFILES,
  structuredOf,
} from '../../../helpers/fixtures.js';
import {
  coded,
  installLanFakes,
  LATENCY,
  type LanFakeOptions,
} from '../../../helpers/lan-fakes.js';

type CheckInput = z.input<typeof wolCheckHost.input>;
type CheckOutput = z.output<typeof wolCheckHost.output>;

const recoveryFor = (reason: string) =>
  wolCheckHost.errors?.find((entry) => entry.reason === reason)?.recovery;

async function check(input: CheckInput, lan: LanFakeOptions = {}) {
  const fakes = installLanFakes(lan);
  const result = await runToolContract(wolCheckHost, input);
  return { fakes, result, structured: structuredOf(result), text: contentText(result) };
}

async function checkFailure(input: CheckInput, lan: LanFakeOptions = {}) {
  const fakes = installLanFakes(lan);
  try {
    await wolCheckHost.handler(
      wolCheckHost.input.parse(input),
      createMockContext({ errors: wolCheckHost.errors }),
    );
  } catch (error) {
    return { fakes, error: error as McpError };
  }
  throw new Error('Expected wol_check_host to fail');
}

beforeEach(async () => {
  await installHosts(Object.values(PROFILES));
});

describe('wol_check_host — outcomes on both surfaces', () => {
  it('open: reachable, with latency', async () => {
    const { structured, text, fakes } = await check(
      { alias: 'gpu-box' },
      { tcp: { '192.0.2.50': ['open'] } },
    );
    expect(structured).toEqual({
      alias: 'gpu-box',
      address: '192.0.2.50',
      check_port: 22,
      reachable: true,
      outcome: 'open',
      latency_ms: LATENCY.open,
    });
    expect(structured).not.toHaveProperty('port');
    expect(fakes.tcp.connects.map((c) => `${c.host}:${c.port}`)).toEqual(['192.0.2.50:22']);
    expect(fakes.tcp.connects[0]?.socket.destroyCount).toBe(1);
    expect(fakes.udp.sockets).toHaveLength(0);
    expect(text).toContain('## gpu-box: open');
    expect(text).toContain('192.0.2.50:22');
    expect(text).toContain(`${LATENCY.open} ms`);
  });

  it("refused: not reachable, with latency and the refused guidance, on the profile's check_port", async () => {
    const { structured, text } = await check(
      { alias: 'nas' },
      { tcp: { 'nas.home.arpa': ['refused'] } },
    );
    expect(structured).toEqual({
      alias: 'nas',
      address: 'nas.home.arpa',
      check_port: 445,
      reachable: false,
      outcome: 'refused',
      latency_ms: LATENCY.refused,
      guidance: refusedGuidance('nas.home.arpa', 445),
    });
    expect(text).toContain('nas.home.arpa:445');
    expect(text).toContain(`> ${refusedGuidance('nas.home.arpa', 445)}`);
  });

  it('silent: no_answer after the 1.5 s timeout, with no latency and wake guidance', async () => {
    const { structured, fakes } = await check(
      { alias: 'gpu-box' },
      { tcp: { '192.0.2.50': ['silent'] } },
    );
    expect(structured).toMatchObject({
      alias: 'gpu-box',
      reachable: false,
      outcome: 'no_answer',
    });
    expect(structured).not.toHaveProperty('latency_ms');
    const guidance = String((structured as { guidance?: string }).guidance);
    expect(guidance).toContain('192.0.2.50:22');
    expect(guidance).toContain('wol_wake_host');
    expect(fakes.clock.now() - 50_000).toBe(PROBE_TIMEOUT_MS);
    expect(fakes.tcp.connects[0]?.socket.destroyCount).toBe(1);
  });

  it('unreachable: no_answer as soon as the error arrives, without waiting out the timeout', async () => {
    const { structured, fakes } = await check(
      { alias: 'gpu-box' },
      { tcp: { '192.0.2.50': ['unreachable'] } },
    );
    expect(structured).toMatchObject({ outcome: 'no_answer', reachable: false });
    expect(fakes.clock.now() - 50_000).toBe(LATENCY.unreachable);
  });

  it('classifies a multi-address refusal hidden behind a timed-out first attempt as refused', async () => {
    const aggregate = Object.assign(
      new AggregateError([coded('ETIMEDOUT'), coded('ECONNREFUSED')], 'connect failed'),
      { code: 'ETIMEDOUT' },
    );
    const { structured } = await check(
      { alias: 'nas' },
      { tcp: { 'nas.home.arpa': [{ kind: 'error', error: aggregate, afterMs: 40 }] } },
    );
    expect(structured).toMatchObject({ outcome: 'refused', latency_ms: 40 });
  });

  it('appends the Local Network note to no_answer guidance on darwin only', async () => {
    const linux = await check({ alias: 'gpu-box' }, { tcp: { '192.0.2.50': ['silent'] } });
    const darwin = await check(
      { alias: 'gpu-box' },
      { tcp: { '192.0.2.50': ['silent'] }, platform: 'darwin' },
    );
    const win32 = await check(
      { alias: 'gpu-box' },
      { tcp: { '192.0.2.50': ['silent'] }, platform: 'win32' },
    );
    const onLinux = String(linux.structured.guidance);
    const onDarwin = String(darwin.structured.guidance);
    expect(onDarwin.startsWith(onLinux)).toBe(true);
    expect(onDarwin.length).toBeGreaterThan(onLinux.length);
    expect(onDarwin).toContain('Local Network');
    expect(onDarwin).toContain('sender-environment');
    expect(String(win32.structured.guidance)).toBe(onLinux);
  });

  it('keeps refused guidance free of the darwin note', async () => {
    const { structured } = await check(
      { alias: 'nas' },
      { tcp: { 'nas.home.arpa': ['refused'] }, platform: 'darwin' },
    );
    expect(structured.guidance).toBe(refusedGuidance('nas.home.arpa', 445));
  });

  it('brackets an IPv6 address before the port', async () => {
    const { structured, text } = await check(
      { alias: 'v6-box' },
      { tcp: { '2001:db8::50': ['silent'] } },
    );
    expect(structured).toMatchObject({ address: '2001:db8::50', check_port: 22 });
    expect(String(structured.guidance)).toContain('[2001:db8::50]:22');
    expect(text).toContain('[2001:db8::50]:22');
  });

  it('resolves the alias case-insensitively', async () => {
    const { structured } = await check({ alias: 'GPU-BOX' }, { tcp: { '192.0.2.50': ['open'] } });
    expect(structured).toMatchObject({ alias: 'gpu-box' });
  });

  it('probes a host on no local subnet, since checking needs no broadcast', async () => {
    const { structured, fakes } = await check(
      { alias: 'cabin-pc' },
      { tcp: { '198.51.100.20': ['open'] } },
    );
    expect(structured).toMatchObject({ reachable: true });
    expect(fakes.interfaceReads).toBe(0);
  });
});

describe('wol_check_host — input', () => {
  it.each(['', 'gpu box', '-gpu', 'a'.repeat(65), 'gpu\r\nbox'])(
    'rejects the malformed alias %j as InvalidParams without probing',
    async (alias) => {
      const { result, fakes } = await check({ alias });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(fakes.tcp.connects).toHaveLength(0);
    },
  );

  it('takes no port input and rejects one, so it cannot probe an arbitrary port', () => {
    expect(Object.keys(wolCheckHost.input.shape)).toEqual(['alias']);
    expect(wolCheckHost.input.safeParse({ alias: 'gpu-box', port: 3389 }).success).toBe(false);
  });
});

describe('wol_check_host — errors', () => {
  it('unknown_host: lists the configured aliases with the contract recovery', async () => {
    const { error, fakes } = await checkFailure({ alias: 'nope' });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'unknown_host',
        alias: 'nope',
        configured_aliases: Object.values(PROFILES).map((p) => p.alias),
        configured_count: Object.values(PROFILES).length,
        recovery: { hint: recoveryFor('unknown_host') },
      },
    });
    expect(fakes.tcp.connects).toHaveLength(0);
  });

  it('unknown_host: switches to the setup hint when no profiles are configured', async () => {
    installNoHosts();
    const { error } = await checkFailure({ alias: 'gpu-box' });
    expect(error.data).toMatchObject({
      reason: 'unknown_host',
      configured_count: 0,
      recovery: { hint: NO_PROFILES_HINT },
    });
  });

  it('no_address: refuses a profile with nothing to probe', async () => {
    const { error, fakes } = await checkFailure({ alias: 'printer' });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: {
        reason: 'no_address',
        alias: 'printer',
        recovery: { hint: recoveryFor('no_address') },
      },
    });
    expect(error.message).toContain('printer');
    expect(fakes.tcp.connects).toHaveLength(0);
  });

  it('returns both error reasons as dual-surface envelopes on the contract path', async () => {
    for (const [alias, reason] of [
      ['nope', 'unknown_host'],
      ['printer', 'no_address'],
    ] as const) {
      const { result } = await check({ alias });
      expect(result.isError).toBe(true);
      expect(errorOf(result).data).toMatchObject({ reason });
      expect(contentText(result)).toContain(`reason ${reason}`);
      expect(contentText(result)).toContain(String(recoveryFor(reason)));
    }
  });

  it('rejects with an abort when cancelled mid-probe, destroying the socket', async () => {
    const fakes = installLanFakes({ tcp: { '192.0.2.50': ['silent'] } });
    const controller = new AbortController();
    fakes.clock.schedule(700, () => controller.abort());
    const ctx = createMockContext({ errors: wolCheckHost.errors, signal: controller.signal });
    await expect(
      wolCheckHost.handler(wolCheckHost.input.parse({ alias: 'gpu-box' }), ctx),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fakes.tcp.connects[0]?.socket.destroyed).toBe(true);
  });
});

describe('wol_check_host — format()', () => {
  const render = (output: CheckOutput) => blocksText(wolCheckHost.format?.(output) ?? []);

  it('renders every field, guidance as a blockquote', () => {
    const text = render({
      alias: 'nas',
      address: 'nas.home.arpa',
      check_port: 445,
      reachable: false,
      outcome: 'refused',
      latency_ms: 12,
      guidance: 'Line one.\nLine two.',
    });
    for (const value of ['## nas: refused', 'nas.home.arpa:445', 'no', '12 ms']) {
      expect(text).toContain(value);
    }
    expect(text).toContain('> Line one.\n> Line two.');
  });

  it('renders reachable as yes for an open port', () => {
    const output: CheckOutput = {
      alias: 'gpu-box',
      address: '192.0.2.50',
      check_port: 22,
      reachable: true,
      outcome: 'open',
      latency_ms: 3,
    };
    expect(render(output)).toContain('yes');
  });
});
