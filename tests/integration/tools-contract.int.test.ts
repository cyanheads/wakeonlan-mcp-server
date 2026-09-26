/**
 * @fileoverview `toolContractSuite` conformance for all four tools: schema,
 * handler, output parse, format(), enrichment, and the dual-surface error
 * envelope, on faked sockets, interfaces, and a virtual clock.
 * @module tests/integration/tools-contract.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach, describe, expect } from 'vitest';
import { wolCheckHost } from '@/mcp-server/tools/definitions/check-host.tool.js';
import { wolListHosts } from '@/mcp-server/tools/definitions/list-hosts.tool.js';
import { wolListReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { wolWakeHost } from '@/mcp-server/tools/definitions/wake-host.tool.js';
import { contentText, installHosts, installNoHosts, PROFILES } from '../helpers/fixtures.js';
import { coded, installLanFakes, type TcpBehavior } from '../helpers/lan-fakes.js';

/** Per-host probe scripts: each alias lands in a different result state. */
const TCP: Record<string, readonly TcpBehavior[]> = {
  '192.0.2.50': ['open'], // gpu-box: already awake
  'nas.home.arpa': ['silent', 'open'], // nas: wakes on the first poll
  '2001:db8::50': ['refused'], // v6-box: on, wrong port
  '198.51.100.20': ['open'], // cabin-pc: off-segment, but probeable
};

const aborted = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

beforeEach(async () => {
  await installHosts(Object.values(PROFILES));
  installLanFakes({ tcp: TCP });
});

toolContractSuite(wolWakeHost, {
  success: [
    {
      name: 'already_awake',
      input: { alias: 'gpu-box' },
      expected: { state: 'already_awake', packets_sent: 3 },
    },
    { name: 'awake', input: { alias: 'nas' }, expected: { state: 'awake', secureon_set: true } },
    {
      name: 'not_reachable with refused guidance',
      input: { alias: 'v6-box', wait_for_s: 3 },
      expected: {
        state: 'not_reachable',
        probe: { address: '2001:db8::50', port: 22, attempts: 2, last_outcome: 'refused' },
      },
    },
    {
      name: 'unverified: no address',
      input: { alias: 'printer' },
      expected: { state: 'unverified', unverified_reason: 'no_address' },
    },
    {
      name: 'unverified: wait disabled, alias matched case-insensitively',
      input: { alias: 'GPU-BOX', wait_for_s: 0 },
      expected: { alias: 'gpu-box', state: 'unverified', unverified_reason: 'wait_disabled' },
    },
    {
      name: 'a blank wait_for_s from a form client takes the default',
      input: { alias: 'gpu-box', wait_for_s: '' },
      expected: { state: 'already_awake' },
      assert: (result) => {
        expect(contentText(result)).toContain('## gpu-box: already_awake');
      },
    },
  ],
  errors: [
    {
      name: 'unknown_host',
      input: { alias: 'missing' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'unknown_host',
    },
    {
      name: 'off_segment (derived)',
      input: { alias: 'cabin-pc' },
      code: JsonRpcErrorCode.ConfigurationError,
      reason: 'off_segment',
    },
    {
      name: 'off_segment (configured)',
      input: { alias: 'lab' },
      code: JsonRpcErrorCode.ConfigurationError,
      reason: 'off_segment',
    },
    {
      name: 'malformed alias',
      input: { alias: '../gpu' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'invalid_arguments',
    },
    {
      name: 'wait above the cap',
      input: { alias: 'gpu-box', wait_for_s: 56 },
      code: JsonRpcErrorCode.InvalidParams,
    },
    {
      name: 'cancelled',
      input: { alias: 'gpu-box' },
      code: JsonRpcErrorCode.RequestCancelled,
      context: { signal: aborted() },
    },
  ],
});

describe('with a UDP stack that refuses the send', () => {
  beforeEach(() => {
    installLanFakes({ tcp: TCP, udp: { failSend: { nth: 2, error: coded('EACCES') } } });
  });

  toolContractSuite(wolWakeHost, {
    success: [],
    errors: [
      {
        name: 'socket_error',
        input: { alias: 'gpu-box' },
        code: JsonRpcErrorCode.ServiceUnavailable,
        reason: 'socket_error',
      },
    ],
  });
});

toolContractSuite(wolCheckHost, {
  success: [
    { name: 'open', input: { alias: 'gpu-box' }, expected: { outcome: 'open', reachable: true } },
    {
      name: 'refused',
      input: { alias: 'v6-box' },
      expected: { outcome: 'refused', reachable: false },
    },
    {
      name: 'no_answer',
      input: { alias: 'lab' },
      expected: { outcome: 'no_answer', reachable: false },
    },
    {
      name: 'off-segment hosts still probe',
      input: { alias: 'cabin-pc' },
      expected: { outcome: 'open' },
    },
  ],
  errors: [
    {
      name: 'unknown_host',
      input: { alias: 'missing' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'unknown_host',
    },
    {
      name: 'no_address',
      input: { alias: 'printer' },
      code: JsonRpcErrorCode.ConfigurationError,
      reason: 'no_address',
    },
    { name: 'malformed alias', input: { alias: 'gpu box' }, code: JsonRpcErrorCode.InvalidParams },
    {
      name: 'cancelled',
      input: { alias: 'gpu-box' },
      code: JsonRpcErrorCode.RequestCancelled,
      context: { signal: aborted() },
    },
  ],
});

toolContractSuite(wolListHosts, {
  success: [
    {
      name: 'lists every configured host with totalCount and the off-segment notice',
      input: {},
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({
          totalCount: Object.values(PROFILES).length,
          config_source: 'inline',
        });
        const notice = (result.structuredContent as { notice?: string }).notice;
        expect(String(notice)).toMatch(/\b2 of 7\b/);
      },
    },
  ],
});

describe('with no host profiles configured', () => {
  beforeEach(() => {
    installNoHosts();
  });

  toolContractSuite(wolListHosts, {
    success: [
      {
        name: 'returns the zero page with totalCount 0 and the setup notice',
        input: {},
        expected: { hosts: [], config_source: 'none' },
        assert: (result) => {
          expect(result.structuredContent).toMatchObject({ totalCount: 0 });
          expect(result.structuredContent).toHaveProperty('notice');
        },
      },
    ],
  });

  toolContractSuite(wolWakeHost, {
    success: [],
    errors: [
      {
        name: 'unknown_host',
        input: { alias: 'gpu-box' },
        code: JsonRpcErrorCode.NotFound,
        reason: 'unknown_host',
      },
    ],
  });
});

toolContractSuite(wolListReference, {
  success: [
    {
      name: 'packet-format',
      input: { topic: 'packet-format' },
      expected: { topic: 'packet-format' },
    },
    {
      name: 'host-profiles',
      input: { topic: 'host-profiles' },
      expected: { topic: 'host-profiles' },
    },
    {
      name: 'sender-environment',
      input: { topic: 'sender-environment' },
      expected: { topic: 'sender-environment' },
    },
  ],
  errors: [
    {
      name: 'unknown topic',
      input: { topic: 'nope' } as never,
      code: JsonRpcErrorCode.InvalidParams,
    },
  ],
});
