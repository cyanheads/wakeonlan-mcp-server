/**
 * @fileoverview Host-profile domain types. Field names keep the hosts file's
 * snake_case so what `wol_list_hosts` shows matches what the operator typed.
 * @module services/hosts/types
 */

/** One operator-configured wake target, validated and normalized at startup. */
export interface HostProfile {
  /** Target's IP literal or DNS hostname; the TCP probe target. */
  address?: string;
  /** Alias as configured (matched case-insensitively). */
  alias: string;
  /** Configured subnet-directed broadcast; derived per call when absent. */
  broadcast?: string;
  /** TCP port probed to confirm the host is up. */
  check_port: number;
  /** Operator note. */
  description?: string;
  /** Lowercase colon form. */
  mac: string;
  /** SecureOn password in lowercase colon form. Never returned or logged. */
  secureon?: string;
  /** UDP destination port for the magic packet. */
  wol_port: number;
}

/** Which env var supplied the profiles. */
export type HostsConfigSource = 'file' | 'inline' | 'none';

/** The loaded, immutable host-profile set. */
export interface LoadedHosts {
  /** Resolved hosts-file path when `source` is `file`. */
  path?: string;
  profiles: readonly HostProfile[];
  source: HostsConfigSource;
}
