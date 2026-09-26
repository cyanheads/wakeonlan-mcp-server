/**
 * @fileoverview Server config: `WOL_HOSTS_FILE` / `WOL_HOSTS` mapping, blank
 * and unsubstituted-placeholder values read as unset, and parse-once caching.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh module instance, so each case parses its own stubbed environment. */
async function freshConfig() {
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

describe('getServerConfig', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps WOL_HOSTS_FILE and WOL_HOSTS', async () => {
    vi.stubEnv('WOL_HOSTS_FILE', '/etc/wol/hosts.json');
    vi.stubEnv('WOL_HOSTS', '[{"alias":"gpu-box"}]');
    const getServerConfig = await freshConfig();
    expect(getServerConfig()).toEqual({
      hostsFile: '/etc/wol/hosts.json',
      hostsJson: '[{"alias":"gpu-box"}]',
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal, unsubstituted ${…} placeholder is the input under test
    ['an unsubstituted placeholder', '${user_config.hosts_file}'],
  ])('reads an %s value as unset', async (_label, value) => {
    vi.stubEnv('WOL_HOSTS_FILE', value);
    vi.stubEnv('WOL_HOSTS', value);
    const getServerConfig = await freshConfig();
    const config = getServerConfig();
    expect(config.hostsFile).toBeUndefined();
    expect(config.hostsJson).toBeUndefined();
  });

  it('parses the environment once and serves the cached result after', async () => {
    vi.stubEnv('WOL_HOSTS_FILE', '/etc/wol/hosts.json');
    vi.stubEnv('WOL_HOSTS', '');
    const getServerConfig = await freshConfig();
    const first = getServerConfig();
    vi.stubEnv('WOL_HOSTS_FILE', '/somewhere/else.json');
    expect(getServerConfig()).toBe(first);
    expect(getServerConfig().hostsFile).toBe('/etc/wol/hosts.json');
  });
});
