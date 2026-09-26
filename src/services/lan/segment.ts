/**
 * @fileoverview IPv4 subnet math and segment resolution: which local interface
 * shares a broadcast domain with a host profile, and which broadcast address a
 * magic packet for it goes to. Pure — the interface table is a parameter.
 * @module services/lan/segment
 */

import { isIPv4 } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import type { HostProfile } from '@/services/hosts/types.js';

/** `os.networkInterfaces()`'s shape. */
export type InterfaceTable = Record<string, NetworkInterfaceInfo[] | undefined>;

/** A local IPv4 subnet the resolver compared against. */
export interface LocalSubnet {
  cidr: string;
  interface: string;
}

export type SegmentResolution =
  | {
      broadcast: string;
      broadcastSource: 'configured' | 'derived';
      interface: string;
      localAddress: string;
      ok: true;
    }
  | {
      /** The configured broadcast; absent when none was configured and none could be derived. */
      broadcast?: string;
      broadcastSource: 'configured' | 'unresolved';
      localSubnets: LocalSubnet[];
      ok: false;
    };

interface CandidateBase {
  address: string;
  cidr: string;
  interface: string;
}

/** A loopback entry, matched by its own address (the verification fixture). */
interface InternalCandidate extends CandidateBase {
  internal: true;
}

/** A LAN entry, matched by subnet. */
interface SubnetCandidate extends CandidateBase {
  broadcast: number;
  internal: false;
  mask: number;
  network: number;
}

type Candidate = InternalCandidate | SubnetCandidate;

/** Dotted quad → unsigned 32-bit integer. Callers pass validated IPv4 literals. */
export function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

/** Unsigned 32-bit integer → dotted quad. */
export function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/**
 * IPv4 entries the resolver can match: internal (loopback) entries by address,
 * and non-internal entries with a prefix of 1–30 by subnet. Entries with a null
 * `cidr` (Node's marker for an invalid netmask), /31 and /32 point-to-point
 * links, and a /0 are skipped.
 */
function candidates(interfaces: InterfaceTable): Candidate[] {
  const result: Candidate[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.cidr === null) continue;
      const base = { interface: name, address: entry.address, cidr: entry.cidr };
      if (entry.internal) {
        result.push({ ...base, internal: true });
        continue;
      }
      const prefix = Number(entry.cidr.split('/')[1]);
      if (!(prefix >= 1 && prefix <= 30)) continue;
      const mask = (0xffffffff << (32 - prefix)) >>> 0;
      const network = (ipv4ToInt(entry.address) & mask) >>> 0;
      result.push({ ...base, internal: false, mask, network, broadcast: (network | ~mask) >>> 0 });
    }
  }
  return result;
}

/**
 * Resolve where a magic packet for `profile` goes and which local address sends it.
 *
 * - `broadcast` configured: it must equal a non-internal entry's directed
 *   broadcast, or the address of an internal (loopback) entry.
 * - `broadcast` omitted: `address` must be an IPv4 literal inside a non-internal
 *   entry's subnet, or equal an internal entry's address.
 *
 * Several matches (Wi-Fi and Ethernet on one subnet): the first in
 * `networkInterfaces()` order wins.
 */
export function resolveSegment(
  profile: Pick<HostProfile, 'address' | 'broadcast'>,
  interfaces: InterfaceTable,
): SegmentResolution {
  const table = candidates(interfaces);
  const localSubnets = table.map((c) => ({ interface: c.interface, cidr: c.cidr }));
  const { address, broadcast } = profile;

  if (broadcast) {
    const target = ipv4ToInt(broadcast);
    const match = table.find((c) =>
      c.internal ? c.address === broadcast : c.broadcast === target,
    );
    return match
      ? {
          ok: true,
          broadcast,
          broadcastSource: 'configured',
          interface: match.interface,
          localAddress: match.address,
        }
      : { ok: false, broadcast, broadcastSource: 'configured', localSubnets };
  }

  if (address && isIPv4(address)) {
    const host = ipv4ToInt(address);
    const match = table.find((c) =>
      c.internal ? c.address === address : (host & c.mask) >>> 0 === c.network,
    );
    if (match) {
      return {
        ok: true,
        broadcast: match.internal ? match.address : intToIpv4(match.broadcast),
        broadcastSource: 'derived',
        interface: match.interface,
        localAddress: match.address,
      };
    }
  }
  return { ok: false, broadcastSource: 'unresolved', localSubnets };
}
