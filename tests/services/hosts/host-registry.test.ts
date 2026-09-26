/**
 * @fileoverview HostRegistry: case-insensitive alias lookup over profiles in
 * config order, and the accessor guard before `initHostRegistry()`.
 * @module tests/services/hosts/host-registry.test
 */

import { describe, expect, it, vi } from 'vitest';
import { HostRegistry } from '@/services/hosts/host-registry.js';
import { loadHostsConfig } from '@/services/hosts/hosts-config.js';
import { PROFILES } from '../../helpers/fixtures.js';

describe('HostRegistry', () => {
  it('keeps the loaded profiles in config order with their source', async () => {
    const loaded = await loadHostsConfig({
      hostsJson: JSON.stringify([PROFILES.nas, PROFILES.gpuBox, PROFILES.printer]),
    });
    const registry = new HostRegistry(loaded);
    expect(registry.source).toBe('inline');
    expect(registry.path).toBeUndefined();
    expect(registry.profiles.map((p) => p.alias)).toEqual(['nas', 'gpu-box', 'printer']);
  });

  it('carries the hosts-file path for a file source', () => {
    const registry = new HostRegistry({
      source: 'file',
      path: '/etc/wol/hosts.json',
      profiles: [],
    });
    expect(registry.path).toBe('/etc/wol/hosts.json');
    expect(registry.source).toBe('file');
  });

  it('finds a profile by alias regardless of case, returning the canonical alias', async () => {
    const registry = new HostRegistry(
      await loadHostsConfig({
        hostsJson: JSON.stringify([{ ...PROFILES.gpuBox, alias: 'GPU-Box' }]),
      }),
    );
    for (const query of ['GPU-Box', 'gpu-box', 'GPU-BOX', 'gPu-bOx']) {
      expect(registry.find(query)?.alias).toBe('GPU-Box');
    }
  });

  it('returns undefined for an alias no profile has', async () => {
    const registry = new HostRegistry(
      await loadHostsConfig({ hostsJson: JSON.stringify([PROFILES.gpuBox]) }),
    );
    expect(registry.find('gpu-box2')).toBeUndefined();
    expect(registry.find('gpu')).toBeUndefined();
    expect(new HostRegistry({ source: 'none', profiles: [] }).find('gpu-box')).toBeUndefined();
  });
});

describe('getHostRegistry', () => {
  it('throws until initHostRegistry() has run, then returns that registry', async () => {
    vi.resetModules();
    const module = await import('@/services/hosts/host-registry.js');
    expect(() => module.getHostRegistry()).toThrow(/not initialized/);
    const registry = new module.HostRegistry({ source: 'none', profiles: [] });
    module.initHostRegistry(registry);
    expect(module.getHostRegistry()).toBe(registry);
  });
});
