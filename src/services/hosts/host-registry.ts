/**
 * @fileoverview Immutable registry of the operator's host profiles with
 * case-insensitive alias lookup. Loaded once in `setup()`; profiles are operator
 * config, not tenant data, so every caller sees the same set.
 * @module services/hosts/host-registry
 */

import type { HostProfile, HostsConfigSource, LoadedHosts } from './types.js';

export class HostRegistry {
  readonly path: string | undefined;
  readonly profiles: readonly HostProfile[];
  readonly source: HostsConfigSource;
  private readonly byAlias: ReadonlyMap<string, HostProfile>;

  constructor(loaded: LoadedHosts) {
    this.source = loaded.source;
    this.path = loaded.path;
    this.profiles = loaded.profiles;
    this.byAlias = new Map(loaded.profiles.map((p) => [p.alias.toLowerCase(), p]));
  }

  /** The profile whose alias matches case-insensitively, if any. */
  find(alias: string): HostProfile | undefined {
    return this.byAlias.get(alias.toLowerCase());
  }
}

let _registry: HostRegistry | undefined;

export function initHostRegistry(registry: HostRegistry): void {
  _registry = registry;
}

export function getHostRegistry(): HostRegistry {
  if (!_registry) {
    throw new Error('HostRegistry not initialized — call initHostRegistry() in setup()');
  }
  return _registry;
}
