/**
 * @fileoverview wol_list_reference: every topic on both surfaces, topic
 * validation, the design's must-cover facts per topic, host-profile examples
 * that load through the real loader, and every topic another tool routes to.
 * @module tests/mcp-server/tools/definitions/list-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { wolCheckHost } from '@/mcp-server/tools/definitions/check-host.tool.js';
import { wolListHosts } from '@/mcp-server/tools/definitions/list-hosts.tool.js';
import { wolListReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { wolWakeHost } from '@/mcp-server/tools/definitions/wake-host.tool.js';
import { NO_PROFILES_HINT } from '@/mcp-server/tools/host-alias.js';
import {
  REFERENCE,
  REFERENCE_TOPICS,
  type ReferenceTopic,
} from '@/mcp-server/tools/reference-topics.js';
import { loadHostsConfig } from '@/services/hosts/hosts-config.js';
import { contentText, errorOf } from '../../../helpers/fixtures.js';

const TOPICS = [
  'packet-format',
  'prerequisites',
  'sleep-states',
  'troubleshooting',
  'host-profiles',
  'sender-environment',
] as const;

describe('wol_list_reference — topics on both surfaces', () => {
  it('serves the six designed topics', () => {
    expect([...REFERENCE_TOPICS]).toEqual([...TOPICS]);
  });

  it.each(TOPICS)(
    'returns %s with its title, content, and every topic for navigation',
    async (topic) => {
      const result = await runToolContract(wolListReference, { topic });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        topic,
        title: REFERENCE[topic].title,
        content: REFERENCE[topic].content,
        topics: [...TOPICS],
      });
      const text = contentText(result);
      expect(text).toContain(`# ${REFERENCE[topic].title}`);
      expect(text).toContain(REFERENCE[topic].content);
      for (const name of TOPICS) expect(text).toContain(name);
    },
  );

  it.each(['', 'packet_format', 'Packet-Format', 'firmware', '../etc/passwd'])(
    'rejects the unknown topic %j as InvalidParams',
    async (topic) => {
      const result = await runToolContract(wolListReference, { topic } as never);
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    },
  );

  it('rejects a missing topic', () => {
    expect(wolListReference.input.safeParse({}).success).toBe(false);
  });
});

describe('wol_list_reference — content covers what the design requires', () => {
  const MUST_COVER: ReadonlyArray<readonly [ReferenceTopic, readonly string[]]> = [
    [
      'packet-format',
      ['0xFF', '102', '108', 'SecureOn', 'UDP', '255.255.255.255', 'SO_BROADCAST', 'WSAEACCES'],
    ],
    [
      'prerequisites',
      ['ErP', 'Wake on Magic Packet', 'Wake-on: g', 'WakeOnLan=magic', 'sopass', 'womp'],
    ],
    ['sleep-states', ['S0', 'S3', 'S4', 'S5', 'G3', 'Fast Startup']],
    [
      'troubleshooting',
      ['on_segment', 'prerequisites', 'sleep-states', 'sender-environment', 'refused', '3389'],
    ],
    [
      'sender-environment',
      ['Local Network', 'TN3179', 'launchd', 'WSL2', 'off_segment', 'bridge', 'VPN'],
    ],
    ['host-profiles', ['WOL_HOSTS_FILE', 'WOL_HOSTS', '~/', 'restart', 'regular file', '1 MiB']],
  ];

  it.each(MUST_COVER)('%s names its required facts', (topic, facts) => {
    for (const fact of facts) expect(REFERENCE[topic].content).toContain(fact);
  });

  it('troubleshooting is an ordered 1–9 checklist', () => {
    const text = REFERENCE.troubleshooting.content;
    for (let step = 1; step <= 9; step++) expect(text).toMatch(new RegExp(`^${step}\\. `, 'm'));
  });

  it.each([
    'alias',
    'mac',
    'address',
    'broadcast',
    'wol_port',
    'check_port',
    'secureon',
    'description',
  ])('host-profiles documents the %s field', (field) => {
    expect(REFERENCE['host-profiles'].content).toContain(`\`${field}\``);
  });

  it('host-profiles: every JSON example loads through the real hosts loader', async () => {
    const examples = [...REFERENCE['host-profiles'].content.matchAll(/```json\n([\s\S]*?)\n```/g)];
    expect(examples.length).toBeGreaterThanOrEqual(4);
    for (const [, example] of examples) {
      const loaded = await loadHostsConfig({ hostsJson: example ?? '' });
      expect(loaded.profiles.length).toBeGreaterThan(0);
    }
  });
});

describe('wol_list_reference — every routed topic exists', () => {
  it('resolves each "topic <name>" another tool points an agent at', () => {
    const recoveries = [wolWakeHost, wolCheckHost].flatMap((tool) =>
      (tool.errors ?? []).map((entry) => entry.recovery),
    );
    const routed = [
      ...recoveries,
      NO_PROFILES_HINT,
      wolWakeHost.description,
      wolCheckHost.description,
      wolListHosts.description,
    ].flatMap((text) => [...text.matchAll(/topic ([a-z-]+)/g)].map((m) => m[1]));
    expect(routed.length).toBeGreaterThan(0);
    for (const topic of routed) expect(REFERENCE_TOPICS).toContain(topic);
  });
});
