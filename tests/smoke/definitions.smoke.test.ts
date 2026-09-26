/**
 * @fileoverview Smoke coverage for the four tool definitions: the designed
 * names, titles, annotations, auth scopes, and error contracts, plus one live
 * run of each through the contract path on the loopback fixture (faked sockets).
 * @module tests/smoke/definitions.smoke.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { wolCheckHost } from '@/mcp-server/tools/definitions/check-host.tool.js';
import { wolListHosts } from '@/mcp-server/tools/definitions/list-hosts.tool.js';
import { wolListReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { wolWakeHost } from '@/mcp-server/tools/definitions/wake-host.tool.js';
import { installHosts, LOOPBACK_TABLE, PROFILES } from '../helpers/fixtures.js';
import { installLanFakes } from '../helpers/lan-fakes.js';

/**
 * The contract metadata the framework acts on. `severity` is the log level the
 * handler factory uses when a thrown error's `data.reason` names that entry;
 * absent keeps `error`.
 */
const contractOf = (
  errors:
    | readonly { code: number; reason: string; retryable?: boolean; severity?: string }[]
    | undefined,
) =>
  (errors ?? []).map(({ reason, code, retryable, severity }) => ({
    reason,
    code,
    retryable,
    severity,
  }));

describe('tool definitions', () => {
  it('wol_wake_host: a non-destructive, idempotent, open-world write under wol:wake', () => {
    expect(wolWakeHost.name).toBe('wol_wake_host');
    expect(wolWakeHost.title).toBe('Wake Host');
    expect(wolWakeHost.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(wolWakeHost.auth).toEqual(['wol:wake']);
    expect(contractOf(wolWakeHost.errors)).toEqual([
      {
        reason: 'unknown_host',
        code: JsonRpcErrorCode.NotFound,
        retryable: undefined,
        severity: 'notice',
      },
      {
        reason: 'off_segment',
        code: JsonRpcErrorCode.ConfigurationError,
        retryable: undefined,
        severity: 'warning',
      },
      // A failed send is a real fault: it keeps the default error level.
      {
        reason: 'socket_error',
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
        severity: undefined,
      },
    ]);
  });

  it('wol_check_host: a read-only, open-world probe under wol:read', () => {
    expect(wolCheckHost.name).toBe('wol_check_host');
    expect(wolCheckHost.title).toBe('Check Host');
    expect(wolCheckHost.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(wolCheckHost.auth).toEqual(['wol:read']);
    expect(contractOf(wolCheckHost.errors)).toEqual([
      {
        reason: 'unknown_host',
        code: JsonRpcErrorCode.NotFound,
        retryable: undefined,
        severity: 'notice',
      },
      {
        reason: 'no_address',
        code: JsonRpcErrorCode.ConfigurationError,
        retryable: undefined,
        severity: 'notice',
      },
    ]);
  });

  it('wol_list_hosts: read-only, closed-world, no declared errors, totalCount enrichment', () => {
    expect(wolListHosts.name).toBe('wol_list_hosts');
    expect(wolListHosts.title).toBe('List Hosts');
    expect(wolListHosts.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(wolListHosts.auth).toEqual(['wol:read']);
    expect(wolListHosts.errors ?? []).toEqual([]);
    expect(Object.keys(wolListHosts.enrichment ?? {}).sort()).toEqual(['notice', 'totalCount']);
  });

  it('wol_list_reference: static, read-only, closed-world, no auth scope', () => {
    expect(wolListReference.name).toBe('wol_list_reference');
    expect(wolListReference.title).toBe('Wake-on-LAN Reference');
    expect(wolListReference.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(wolListReference.auth ?? []).toEqual([]);
    expect(wolListReference.errors ?? []).toEqual([]);
  });
});

describe('each tool runs once on the loopback fixture', () => {
  it('lists, checks, wakes, and reads a reference topic without error', async () => {
    await installHosts([PROFILES.loopback]);
    const fakes = installLanFakes({ interfaces: LOOPBACK_TABLE, tcp: { '127.0.0.1': ['open'] } });

    const listed = await runToolContract(wolListHosts, {});
    const reference = await runToolContract(wolListReference, { topic: 'troubleshooting' });
    const checked = await runToolContract(wolCheckHost, { alias: 'loopback' });
    const woken = await runToolContract(wolWakeHost, { alias: 'loopback' });
    for (const result of [listed, reference, checked, woken]) expect(result.isError).not.toBe(true);

    expect(listed.structuredContent).toMatchObject({
      hosts: [{ alias: 'loopback', on_segment: true }],
    });
    expect(checked.structuredContent).toMatchObject({ outcome: 'open', check_port: 40022 });
    expect(woken.structuredContent).toMatchObject({
      state: 'already_awake',
      broadcast: '127.0.0.1',
      wol_port: 40009,
    });
    expect(fakes.udp.only.sends.map((s) => `${s.address}:${s.port}`)).toEqual(
      Array(3).fill('127.0.0.1:40009'),
    );
  });
});
