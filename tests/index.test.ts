/**
 * @fileoverview Server entry wiring. `createApp` is replaced at the framework
 * boundary so importing `src/index.ts` captures its options instead of starting
 * a transport; `setup()` then runs against a fake core. Covers the identity and
 * tool surface, the exposure guard running before any hosts config is read, the
 * zero-profile warning, and service initialization.
 * @module tests/index.test
 */

import type { CoreServices, CreateAppOptions } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpExposureConfig } from '@/config/http-exposure.js';
import { PROFILES } from './helpers/fixtures.js';

const captured = vi.hoisted(() => ({ options: [] as CreateAppOptions[] }));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core')>();
  return {
    ...actual,
    createApp: async (options: CreateAppOptions) => {
      captured.options.push(options);
      return {};
    },
  };
});

/** Import a fresh copy of the entry point under the given hosts env, capturing its options. */
async function boot(env: { WOL_HOSTS?: string; WOL_HOSTS_FILE?: string } = {}) {
  vi.resetModules();
  captured.options.length = 0;
  vi.stubEnv('WOL_HOSTS_FILE', env.WOL_HOSTS_FILE ?? '');
  vi.stubEnv('WOL_HOSTS', env.WOL_HOSTS ?? '');
  await import('@/index.js');
  expect(captured.options).toHaveLength(1);
  const options = captured.options[0] as CreateAppOptions;
  // Same module generation as the entry point just imported, so these see its singletons.
  const registry = await import('@/services/hosts/host-registry.js');
  const lan = await import('@/services/lan/lan-service.js');
  return { options, registry, lan };
}

function fakeCore(config: Partial<HttpExposureConfig> = {}) {
  const warnings: unknown[] = [];
  const core = {
    config: {
      mcpTransportType: 'stdio',
      mcpHttpHost: '127.0.0.1',
      mcpAuthMode: 'none',
      devMcpAuthBypass: false,
      ...config,
    },
    logger: { warning: (message: unknown) => warnings.push(message) },
  };
  return { core: core as unknown as CoreServices, warnings };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createApp options', () => {
  it('registers the four tools, no resources or prompts, stateless, under the repo name', async () => {
    const { options } = await boot();
    expect(options.name).toBe('wakeonlan-mcp-server');
    expect(options.title).toBe('wakeonlan-mcp-server');
    expect(options.tools?.map((t) => t.name)).toEqual([
      'wol_wake_host',
      'wol_check_host',
      'wol_list_hosts',
      'wol_list_reference',
    ]);
    expect(options.resources).toEqual([]);
    expect(options.prompts).toEqual([]);
    expect(options.sessionMode).toBe('stateless');
    expect(typeof options.setup).toBe('function');
    expect(options.teardown).toBeUndefined();
    for (const field of ['description', 'websiteUrl', 'icons'] as const) {
      expect(options[field]).toBeUndefined();
    }
  });

  it('sends instructions that name every tool', async () => {
    const { options } = await boot();
    expect(typeof options.instructions).toBe('string');
    for (const tool of [
      'wol_list_hosts',
      'wol_wake_host',
      'wol_check_host',
      'wol_list_reference',
    ]) {
      expect(options.instructions).toContain(tool);
    }
  });
});

describe('setup()', () => {
  it('loads profiles from WOL_HOSTS and initializes both services', async () => {
    const { options, registry, lan } = await boot({
      WOL_HOSTS: JSON.stringify([PROFILES.gpuBox, PROFILES.nas]),
    });
    const { core, warnings } = fakeCore();
    await options.setup?.(core);
    expect(registry.getHostRegistry().source).toBe('inline');
    expect(registry.getHostRegistry().profiles.map((p) => p.alias)).toEqual(['gpu-box', 'nas']);
    expect(lan.getLanService()).toBeInstanceOf(lan.LanService);
    expect(warnings).toEqual([]);
  });

  it('starts with zero profiles and a warning when neither variable is set', async () => {
    const { options, registry } = await boot();
    const { core, warnings } = fakeCore();
    await options.setup?.(core);
    expect(registry.getHostRegistry()).toMatchObject({ source: 'none', profiles: [] });
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0])).toContain('WOL_HOSTS');
  });

  it('refuses an unauthenticated non-loopback HTTP bind before reading any hosts config', async () => {
    const { options, registry } = await boot({ WOL_HOSTS: 'not json' });
    const { core } = fakeCore({ mcpTransportType: 'http', mcpHttpHost: '0.0.0.0' });
    const setup = Promise.resolve(options.setup?.(core));
    await expect(setup).rejects.toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    await expect(setup).rejects.toThrow(/MCP_HTTP_HOST/);
    expect(() => registry.getHostRegistry()).toThrow(/not initialized/);
  });

  it('fails startup with the hosts-config ConfigurationError', async () => {
    const { options, registry } = await boot({ WOL_HOSTS: 'not json' });
    const setup = Promise.resolve(options.setup?.(fakeCore().core));
    await expect(setup).rejects.toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    await expect(setup).rejects.toThrow(/WOL_HOSTS/);
    expect(() => registry.getHostRegistry()).toThrow(/not initialized/);
  });

  it('fails startup when both hosts variables are set', async () => {
    const { options } = await boot({ WOL_HOSTS: '[]', WOL_HOSTS_FILE: '/etc/wol/hosts.json' });
    await expect(Promise.resolve(options.setup?.(fakeCore().core))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
    });
  });
});
