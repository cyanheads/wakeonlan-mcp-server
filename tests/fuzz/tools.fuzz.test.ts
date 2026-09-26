/**
 * @fileoverview Property-based fuzzing of all four tools on the same fakes and
 * virtual clock the unit suites use. Short aliases are configured so generated
 * inputs hit real profiles and drive the send and probe paths; the socket
 * tripwire guarantees none of it reaches the OS.
 * @module tests/fuzz/tools.fuzz.test
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { beforeEach, describe, expect, it } from 'vitest';
import { wolCheckHost } from '@/mcp-server/tools/definitions/check-host.tool.js';
import { wolListHosts } from '@/mcp-server/tools/definitions/list-hosts.tool.js';
import { wolListReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { wolWakeHost } from '@/mcp-server/tools/definitions/wake-host.tool.js';
import { installHosts, PROFILES } from '../helpers/fixtures.js';
import { installLanFakes, type LanFakes } from '../helpers/lan-fakes.js';

const SEED = 20_260_926;

/**
 * One profile per single-character alias, rotating through the shapes that
 * reach different branches: derived broadcast, no address, off-segment, and a
 * configured broadcast with a hostname address.
 */
const SHORT_ALIAS_PROFILES = [...'abcdefghijklmnopqrstuvwxyz0123456789'].map((alias, i) => {
  const mac = `02:00:5e:00:53:${i.toString(16).padStart(2, '0')}`;
  switch (i % 4) {
    case 0:
      return { alias, mac, address: `192.0.2.${20 + i}` };
    case 1:
      return { alias, mac, broadcast: '192.0.2.255' };
    case 2:
      return { alias, mac, address: `198.51.100.${20 + i}` };
    default:
      return {
        alias,
        mac,
        address: `host-${alias}.home.arpa`,
        broadcast: '192.0.2.255',
        secureon: 'a1:b2:c3:d4:e5:f6',
      };
  }
});

let fakes: LanFakes;

beforeEach(async () => {
  await installHosts([...Object.values(PROFILES), ...SHORT_ALIAS_PROFILES]);
  fakes = installLanFakes({ tcpFallback: 'refused', tcp: { '192.0.2.20': ['silent', 'open'] } });
});

describe('fuzz', () => {
  it.each([
    ['wol_wake_host', wolWakeHost],
    ['wol_check_host', wolCheckHost],
    ['wol_list_hosts', wolListHosts],
    ['wol_list_reference', wolListReference],
  ] as const)('%s survives generated and adversarial inputs', async (_name, definition) => {
    const report = await fuzzTool(definition, { numRuns: 60, numAdversarial: 30, seed: SEED });
    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(0);
    expect(report.prototypePollution).toBe(false);
  });

  it('reaches configured profiles, so the send and probe paths are fuzzed too', async () => {
    await fuzzTool(wolWakeHost, { numRuns: 200, numAdversarial: 0, seed: SEED });
    expect(fakes.udp.sockets.length).toBeGreaterThan(0);
    expect(fakes.udp.sockets.every((socket) => socket.closed)).toBe(true);
    expect(fakes.tcp.connects.every((connect) => connect.socket.destroyed)).toBe(true);
  });
});
