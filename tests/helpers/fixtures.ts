/**
 * @fileoverview Shared fixtures: `os.networkInterfaces()`-shaped tables, host
 * profiles in the hosts-file format (loaded through the real loader), magic
 * packet vectors built independently of the code under test, and helpers for
 * reading a tool result's `content[]`. Addresses are RFC 5737 / RFC 3849
 * documentation ranges and MACs are RFC 7042 documentation values.
 * @module tests/helpers/fixtures
 */

import type { NetworkInterfaceInfo } from 'node:os';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { HostRegistry, initHostRegistry } from '@/services/hosts/host-registry.js';
import { loadHostsConfig } from '@/services/hosts/hosts-config.js';
import type { InterfaceTable } from '@/services/lan/segment.js';

/** An IPv4 entry as `os.networkInterfaces()` reports it. */
export function v4(
  address: string,
  netmask: string,
  cidr: string | null,
  internal = false,
): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: internal ? '00:00:00:00:00:00' : '02:00:5e:10:00:01',
    internal,
    cidr,
  };
}

/** An IPv6 entry as `os.networkInterfaces()` reports it. */
export function v6(address: string, cidr: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: internal ? '00:00:00:00:00:00' : '02:00:5e:10:00:01',
    internal,
    cidr,
    scopeid: internal ? 0 : 4,
  };
}

const LO0 = [v4('127.0.0.1', '255.0.0.0', '127.0.0.1/8', true), v6('::1', '::1/128', true)];

/** A laptop on one /24: loopback plus `en0` at 192.0.2.10. */
export const LAN_TABLE: InterfaceTable = {
  lo0: LO0,
  en0: [v6('fe80::1', 'fe80::1/64'), v4('192.0.2.10', '255.255.255.0', '192.0.2.10/24')],
};

/** Wi-Fi and Ethernet on the same /24. */
export const TWO_NIC_TABLE: InterfaceTable = {
  lo0: LO0,
  en0: [v4('192.0.2.10', '255.255.255.0', '192.0.2.10/24')],
  en1: [v4('192.0.2.11', '255.255.255.0', '192.0.2.11/24')],
};

/** Point-to-point links only: a /32 VPN tunnel and a /31 link. */
export const TUNNEL_TABLE: InterfaceTable = {
  lo0: LO0,
  utun3: [v4('198.51.100.7', '255.255.255.255', '198.51.100.7/32')],
  ppp0: [v4('203.0.113.0', '255.255.255.254', '203.0.113.0/31')],
};

/** Loopback only — the live-verification fixture's view. */
export const LOOPBACK_TABLE: InterfaceTable = { lo0: LO0 };

/** No interfaces at all. */
export const EMPTY_TABLE: InterfaceTable = {};

/** The SecureOn password the fixtures carry, as the operator typed it and as stored. */
export const SECUREON = { typed: 'A1-B2-C3-D4-E5-F6', stored: 'a1:b2:c3:d4:e5:f6' } as const;

/** Host profiles in hosts-file form. */
export const PROFILES = {
  /** Derives its broadcast from `en0` in {@link LAN_TABLE}. */
  gpuBox: {
    alias: 'gpu-box',
    description: 'Desktop with the training GPU; SSH on 22.',
    mac: '00:00:5e:00:53:01',
    address: '192.0.2.50',
  },
  /** Hostname address with a configured broadcast, SMB check port, and a SecureOn password. */
  nas: {
    alias: 'nas',
    mac: '00-00-5E-00-53-02',
    address: 'nas.home.arpa',
    broadcast: '192.0.2.255',
    check_port: 445,
    secureon: SECUREON.typed,
  },
  /** No address: a wake cannot be confirmed. */
  printer: { alias: 'printer', mac: '00:00:5e:00:53:03', broadcast: '192.0.2.255' },
  /** IPv4 address on no local subnet: the broadcast cannot be derived. */
  cabin: { alias: 'cabin-pc', mac: '00:00:5e:00:53:04', address: '198.51.100.20' },
  /** Configured broadcast of a subnet this machine is not on. */
  lab: {
    alias: 'lab',
    mac: '00:00:5e:00:53:05',
    address: 'lab.home.arpa',
    broadcast: '203.0.113.255',
  },
  /** IPv6 probe address; packets still go to the IPv4 broadcast. */
  v6Box: {
    alias: 'v6-box',
    mac: '00:00:5e:00:53:06',
    address: '2001:db8::50',
    broadcast: '192.0.2.255',
    wol_port: 7,
  },
  /** The loopback live-verification profile. */
  loopback: {
    alias: 'loopback',
    mac: '00:00:5e:00:53:01',
    address: '127.0.0.1',
    broadcast: '127.0.0.1',
    wol_port: 40009,
    check_port: 40022,
  },
} as const;

/** Load profiles through the real hosts loader (inline source) and install the registry. */
export async function installHosts(profiles: readonly object[]): Promise<HostRegistry> {
  const registry = new HostRegistry(await loadHostsConfig({ hostsJson: JSON.stringify(profiles) }));
  initHostRegistry(registry);
  return registry;
}

/** Install an empty registry, as when neither hosts variable is set. */
export function installNoHosts(): HostRegistry {
  const registry = new HostRegistry({ source: 'none', profiles: [] });
  initHostRegistry(registry);
  return registry;
}

/**
 * The expected magic packet, spelled out from hex so it does not share code
 * with `buildMagicPacket`: 6 × 0xFF, the MAC 16 times, then the optional
 * 6-byte SecureOn password.
 */
export function magicPacketHex(macHex: string, secureonHex = ''): Buffer {
  return Buffer.from(`${'ff'.repeat(6)}${macHex.repeat(16)}${secureonHex}`, 'hex');
}

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** `structuredContent` of a tool result (empty when absent). */
export function structuredOf(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

/** The text of every `content[]` text block, joined. */
export function contentText(result: ToolResult): string {
  return blocksText(result.content ?? []);
}

/** The text of a `format()` block list, joined. */
export function blocksText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');
}

/** `structuredContent.error` of a failed tool result. */
export function errorOf(result: ToolResult): {
  code: number;
  data?: Record<string, unknown>;
  message: string;
} {
  const error = (result.structuredContent as { error?: unknown } | undefined)?.error;
  if (!error) throw new Error(`Expected an error result, got ${JSON.stringify(result)}`);
  return error as { code: number; data?: Record<string, unknown>; message: string };
}
