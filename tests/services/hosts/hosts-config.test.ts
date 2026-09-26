/**
 * @fileoverview Host-profile loader: both sources, `~/` expansion, blank
 * optional fields, normalization, and every startup `ConfigurationError` —
 * none of which may carry a SecureOn value.
 * @module tests/services/hosts/hosts-config.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { type HostsConfigDeps, loadHostsConfig } from '@/services/hosts/hosts-config.js';
import { coded } from '../../helpers/lan-fakes.js';

const HOME = '/home/operator';
const MAC = '00:00:5e:00:53:01';
const HOSTS_PATH = '/etc/wol/hosts.json';

const MIB = 1024 * 1024;

/** A directory, FIFO, or device node: `stat` reports it as not a regular file. */
const SPECIAL = Symbol('special file');

/**
 * In-memory filesystem. A string is a regular file holding that text (its
 * `stat` size is the UTF-8 byte length); an Error is a regular file whose read
 * fails with it; {@link SPECIAL} is a non-regular file, which fails the test if
 * it is ever read. A missing path fails `stat` and `readFile` with ENOENT.
 */
function fakeFs(files: Record<string, string | Error | typeof SPECIAL> = {}) {
  const reads: Array<{ encoding: string; path: string }> = [];
  const missing = (path: string) => coded('ENOENT', `ENOENT: no such file or directory, '${path}'`);
  const deps: HostsConfigDeps = {
    homedir: () => HOME,
    stat: async (path) => {
      const file = files[path];
      if (file === undefined) throw missing(path);
      return {
        isFile: () => file !== SPECIAL,
        size: typeof file === 'string' ? Buffer.byteLength(file) : 0,
      };
    },
    readFile: async (path, encoding) => {
      reads.push({ path, encoding });
      const file = files[path];
      if (file === undefined) throw missing(path);
      if (file === SPECIAL) throw new Error(`Read a non-regular file: ${path}`);
      if (file instanceof Error) throw file;
      return file;
    },
  };
  return { deps, reads };
}

const inline = (document: unknown) => loadHostsConfig({ hostsJson: JSON.stringify(document) });

/** Dot-joined labels of the given lengths: `labels(3, 2)` → `aaa.bb`. */
const labels = (...lengths: number[]) =>
  lengths.map((length, i) => String.fromCharCode(97 + i).repeat(length)).join('.');

/** Await a rejection and assert it is a ConfigurationError. */
async function configurationFailure(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => {
      throw new Error('Expected a ConfigurationError, but the load succeeded');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(McpError);
  expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
  return error as McpError;
}

describe('loadHostsConfig — sources', () => {
  it('starts with zero profiles when neither variable is set, reading no file', async () => {
    const fs = fakeFs();
    await expect(loadHostsConfig({}, fs.deps)).resolves.toEqual({ source: 'none', profiles: [] });
    expect(fs.reads).toEqual([]);
  });

  it('treats blank values as unset, so one blank source never counts as both set', async () => {
    const fs = fakeFs();
    await expect(loadHostsConfig({ hostsFile: '', hostsJson: '' }, fs.deps)).resolves.toEqual({
      source: 'none',
      profiles: [],
    });
    const hostsJson = JSON.stringify([{ alias: 'a', mac: MAC, address: '192.0.2.5' }]);
    const loaded = await loadHostsConfig({ hostsFile: '', hostsJson }, fs.deps);
    expect(loaded.source).toBe('inline');
    expect(fs.reads).toEqual([]);
  });

  it('loads WOL_HOSTS inline with no path', async () => {
    const loaded = await inline([{ alias: 'gpu-box', mac: MAC, address: '192.0.2.50' }]);
    expect(loaded).toEqual({
      source: 'inline',
      profiles: [
        { alias: 'gpu-box', mac: MAC, address: '192.0.2.50', wol_port: 9, check_port: 22 },
      ],
    });
    expect('path' in loaded).toBe(false);
  });

  it('accepts an empty array as a valid zero-profile document', async () => {
    await expect(inline([])).resolves.toEqual({ source: 'inline', profiles: [] });
  });

  it('reads WOL_HOSTS_FILE from an absolute path as UTF-8 and reports the path', async () => {
    const fs = fakeFs({
      [HOSTS_PATH]: JSON.stringify([{ alias: 'nas', mac: MAC, broadcast: '192.0.2.255' }]),
    });
    const loaded = await loadHostsConfig({ hostsFile: HOSTS_PATH }, fs.deps);
    expect(loaded).toMatchObject({ source: 'file', path: HOSTS_PATH });
    expect(loaded.profiles.map((p) => p.alias)).toEqual(['nas']);
    expect(fs.reads).toEqual([{ path: HOSTS_PATH, encoding: 'utf8' }]);
  });

  it('expands a leading ~/ against the injected home directory', async () => {
    const path = `${HOME}/.config/wol/hosts.json`;
    const fs = fakeFs({ [path]: '[]' });
    await expect(
      loadHostsConfig({ hostsFile: '~/.config/wol/hosts.json' }, fs.deps),
    ).resolves.toEqual({ source: 'file', path, profiles: [] });
    expect(fs.reads.map((r) => r.path)).toEqual([path]);
  });

  it('ignores a UTF-8 byte-order mark at the start of the hosts file (Windows editors write one)', async () => {
    const document = JSON.stringify([{ alias: 'nas', mac: MAC, broadcast: '192.0.2.255' }]);
    const fs = fakeFs({ [HOSTS_PATH]: `﻿${document}` });
    const loaded = await loadHostsConfig({ hostsFile: HOSTS_PATH }, fs.deps);
    expect(loaded.profiles.map((p) => p.alias)).toEqual(['nas']);
  });

  it('parses the documented hosts-file example into normalized profiles', async () => {
    const loaded = await inline([
      {
        alias: 'gpu-box',
        description: 'Desktop with the training GPU; SSH on 22.',
        mac: '00:00:5e:00:53:01',
        address: '192.0.2.50',
      },
      {
        alias: 'nas',
        mac: '00-00-5E-00-53-02',
        address: 'nas.home.arpa',
        broadcast: '192.0.2.255',
        check_port: 445,
        secureon: '00:00:5e:00:53:ff',
      },
    ]);
    expect(loaded.profiles).toEqual([
      {
        alias: 'gpu-box',
        description: 'Desktop with the training GPU; SSH on 22.',
        mac: '00:00:5e:00:53:01',
        address: '192.0.2.50',
        wol_port: 9,
        check_port: 22,
      },
      {
        alias: 'nas',
        mac: '00:00:5e:00:53:02',
        address: 'nas.home.arpa',
        broadcast: '192.0.2.255',
        wol_port: 9,
        check_port: 445,
        secureon: '00:00:5e:00:53:ff',
      },
    ]);
  });
});

describe('loadHostsConfig — profile fields', () => {
  it('treats blank optional strings as unset, leaving no key behind', async () => {
    const blanks = { broadcast: '', secureon: '', description: '' };
    const [profile] = (
      await inline([{ alias: 'gpu-box', mac: MAC, address: '192.0.2.50', ...blanks }])
    ).profiles;
    expect(profile).toEqual({
      alias: 'gpu-box',
      mac: MAC,
      address: '192.0.2.50',
      wol_port: 9,
      check_port: 22,
    });
    expect(Object.keys(profile ?? {}).sort()).toEqual([
      'address',
      'alias',
      'check_port',
      'mac',
      'wol_port',
    ]);

    const [noAddress] = (
      await inline([{ alias: 'p', mac: MAC, address: '', broadcast: '192.0.2.255' }])
    ).profiles;
    expect(noAddress).toBeDefined();
    expect(noAddress).not.toHaveProperty('address');
  });

  it.each([
    ['0000.5E00.5301', '00:00:5e:00:53:01'],
    ['00005E005301', '00:00:5e:00:53:01'],
    ['0-0-5e-0-53-1', '00:00:5e:00:53:01'],
  ])('normalizes the MAC %s to %s', async (mac, normalized) => {
    const loaded = await inline([{ alias: 'a', mac, address: '192.0.2.5' }]);
    expect(loaded.profiles[0]?.mac).toBe(normalized);
  });

  it('normalizes a SecureOn password, accepting a group-bit value', async () => {
    const loaded = await inline([
      { alias: 'a', mac: MAC, address: '192.0.2.5', secureon: '01-23-45-67-89-AB' },
    ]);
    expect(loaded.profiles[0]?.secureon).toBe('01:23:45:67:89:ab');
  });

  it.each([1, 65535])('accepts the port boundary %d for wol_port and check_port', async (port) => {
    const loaded = await inline([
      { alias: 'a', mac: MAC, address: '192.0.2.5', wol_port: port, check_port: port },
    ]);
    expect(loaded.profiles[0]).toMatchObject({ wol_port: port, check_port: port });
  });

  it.each([
    ['an IPv4 literal', '192.0.2.50'],
    ['an IPv6 literal', '2001:db8::50'],
    ['a hostname', 'nas.home.arpa'],
    ['a hostname with a trailing dot', 'nas.home.arpa.'],
    ['a single label', 'nas'],
    ['a 63-character label', `${'a'.repeat(63)}.home.arpa`],
    ['a 253-character name', labels(63, 63, 63, 61)],
  ])('accepts %s as the address', async (_label, address) => {
    const loaded = await inline([{ alias: 'a', mac: MAC, address, broadcast: '192.0.2.255' }]);
    expect(loaded.profiles[0]?.address).toBe(address);
  });

  it('accepts a 500-character description', async () => {
    const description = 'x'.repeat(500);
    const loaded = await inline([{ alias: 'a', mac: MAC, address: '192.0.2.5', description }]);
    expect(loaded.profiles[0]?.description).toBe(description);
  });
});

describe('loadHostsConfig — startup ConfigurationErrors', () => {
  it('refuses both variables set at once', async () => {
    const error = await configurationFailure(
      loadHostsConfig({ hostsFile: HOSTS_PATH, hostsJson: '[]' }, fakeFs().deps),
    );
    expect(error.message).toContain('WOL_HOSTS_FILE');
    expect(error.message).toContain('WOL_HOSTS');
  });

  it.each(['hosts.json', './hosts.json', '../hosts.json', '~user/hosts.json', '~'])(
    'refuses the relative hosts-file path %j without reading anything',
    async (hostsFile) => {
      const fs = fakeFs();
      const error = await configurationFailure(loadHostsConfig({ hostsFile }, fs.deps));
      expect(error.message).toContain('WOL_HOSTS_FILE');
      expect(error.message).toContain(hostsFile);
      expect(fs.reads).toEqual([]);
    },
  );

  it('reports a missing hosts file (ENOENT from stat) without reading it', async () => {
    const fs = fakeFs();
    const error = await configurationFailure(loadHostsConfig({ hostsFile: HOSTS_PATH }, fs.deps));
    expect(error.message).toContain(`WOL_HOSTS_FILE (${HOSTS_PATH}) could not be read (ENOENT)`);
    expect(error.cause).toMatchObject({ code: 'ENOENT' });
    expect(fs.reads).toEqual([]);
  });

  it.each([
    ['ENOENT', coded('ENOENT')],
    ['EACCES', coded('EACCES')],
    ['EIO', coded('EIO')],
  ])('reports a hosts file whose read fails (%s) with its errno code', async (code, failure) => {
    const error = await configurationFailure(
      loadHostsConfig({ hostsFile: HOSTS_PATH }, fakeFs({ [HOSTS_PATH]: failure }).deps),
    );
    expect(error.message).toContain(HOSTS_PATH);
    expect(error.message).toContain(code);
    expect(error.cause).toBe(failure);
  });

  it.each(['/dev/stdin', '/dev/zero', '/tmp/wol.fifo', '/etc/wol'])(
    'refuses %s, which is not a regular file, without reading it',
    async (path) => {
      const fs = fakeFs({ [path]: SPECIAL });
      const error = await configurationFailure(loadHostsConfig({ hostsFile: path }, fs.deps));
      expect(error.message).toContain(`WOL_HOSTS_FILE (${path}) is not a regular file`);
      expect(fs.reads).toEqual([]);
    },
  );

  it('refuses a hosts file 1 byte over 1 MiB without reading it', async () => {
    const fs = fakeFs({ [HOSTS_PATH]: `[${' '.repeat(MIB - 1)}]` });
    const error = await configurationFailure(loadHostsConfig({ hostsFile: HOSTS_PATH }, fs.deps));
    expect(error.message).toContain(`WOL_HOSTS_FILE (${HOSTS_PATH}) is ${MIB + 1} bytes`);
    expect(error.message).toContain('1 MiB');
    expect(fs.reads).toEqual([]);
  });

  it('loads a hosts file of exactly 1 MiB', async () => {
    const fs = fakeFs({ [HOSTS_PATH]: `[${' '.repeat(MIB - 2)}]` });
    await expect(loadHostsConfig({ hostsFile: HOSTS_PATH }, fs.deps)).resolves.toEqual({
      source: 'file',
      path: HOSTS_PATH,
      profiles: [],
    });
    expect(fs.reads).toHaveLength(1);
  });

  it('reports an unreadable hosts file whose error carries no code', async () => {
    const error = await configurationFailure(
      loadHostsConfig({ hostsFile: HOSTS_PATH }, fakeFs({ [HOSTS_PATH]: new Error('boom') }).deps),
    );
    expect(error.message).toContain(HOSTS_PATH);
    expect(error.message).not.toContain('undefined');
  });

  it('refuses a hosts file that is not JSON, naming the file', async () => {
    const error = await configurationFailure(
      loadHostsConfig({ hostsFile: HOSTS_PATH }, fakeFs({ [HOSTS_PATH]: '[{ alias: x }]' }).deps),
    );
    expect(error.message).toContain(`WOL_HOSTS_FILE (${HOSTS_PATH})`);
  });

  it('refuses WOL_HOSTS that is not JSON', async () => {
    const error = await configurationFailure(loadHostsConfig({ hostsJson: '{"alias":' }));
    expect(error.message).toContain('WOL_HOSTS');
    expect(error.message).not.toContain('WOL_HOSTS_FILE');
  });

  it.each([
    ['an object', {}],
    ['a string', 'gpu-box'],
    ['null', null],
    ['a number', 42],
  ])('refuses a document that is %s rather than an array', async (_label, document) => {
    const error = await configurationFailure(inline(document));
    expect(error.message).toContain('WOL_HOSTS');
    expect(error.message).toContain('array');
  });

  const valid = { alias: 'gpu-box', mac: MAC, address: '192.0.2.50' };
  /** A loadable "nas" profile, and one addressed by hostname, before the bad field lands. */
  const nas = { alias: 'nas', mac: MAC, address: '192.0.2.5' };
  const byName = { alias: 'nas', mac: MAC, broadcast: '192.0.2.255' };

  /** [label, entry, the field the error must name — none when the entry is not an object]. */
  const INVALID_ENTRIES: ReadonlyArray<readonly [string, unknown, string | undefined]> = [
    ['a missing alias', { mac: MAC, address: '192.0.2.5' }, 'alias'],
    ['an alias with a space', { ...nas, alias: 'nas box' }, 'alias'],
    ['an alias starting with a dot', { ...nas, alias: '.nas' }, 'alias'],
    ['a 65-character alias', { ...nas, alias: 'a'.repeat(65) }, 'alias'],
    ['a missing MAC', { alias: 'nas', address: '192.0.2.5' }, 'mac'],
    ['a malformed MAC', { ...nas, mac: '00:00:5e:00:53' }, 'mac'],
    ['a group MAC', { ...nas, mac: '01:00:5e:00:00:fb' }, 'mac'],
    ['an all-zero MAC', { ...nas, mac: '00:00:00:00:00:00' }, 'mac'],
    ['a numeric MAC', { ...nas, mac: 5_000_000 }, 'mac'],
    ['an address with an underscore', { ...byName, address: 'bad_host' }, 'address'],
    ['a leading-hyphen label', { ...byName, address: '-nas.home.arpa' }, 'address'],
    ['a trailing-hyphen label', { ...byName, address: 'nas-.home.arpa' }, 'address'],
    ['an empty label', { ...byName, address: 'nas..arpa' }, 'address'],
    ['a 64-character label', { ...byName, address: labels(64, 4) }, 'address'],
    ['a 254-character address', { ...byName, address: labels(63, 63, 63, 62) }, 'address'],
    ['an address with a newline', { ...byName, address: 'nas\n## injected' }, 'address'],
    ['a hostname broadcast', { ...nas, broadcast: 'lan.home.arpa' }, 'broadcast'],
    ['an out-of-range broadcast', { ...nas, broadcast: '192.0.2.256' }, 'broadcast'],
    ['a CIDR broadcast', { ...nas, broadcast: '192.0.2.0/24' }, 'broadcast'],
    ['the limited broadcast', { ...nas, broadcast: '255.255.255.255' }, 'broadcast'],
    ['0.0.0.0 as the broadcast', { ...nas, broadcast: '0.0.0.0' }, 'broadcast'],
    ['multicast 224.0.0.1 as the broadcast', { ...nas, broadcast: '224.0.0.1' }, 'broadcast'],
    ['multicast 239.255.255.250', { ...nas, broadcast: '239.255.255.250' }, 'broadcast'],
    ['wol_port 0', { ...nas, wol_port: 0 }, 'wol_port'],
    ['wol_port 65536', { ...nas, wol_port: 65536 }, 'wol_port'],
    ['a fractional wol_port', { ...nas, wol_port: 9.5 }, 'wol_port'],
    ['a string wol_port', { ...nas, wol_port: '9' }, 'wol_port'],
    ['check_port 0', { ...nas, check_port: 0 }, 'check_port'],
    ['check_port 70000', { ...nas, check_port: 70_000 }, 'check_port'],
    ['a negative check_port', { ...nas, check_port: -22 }, 'check_port'],
    ['a string check_port', { ...nas, check_port: '22' }, 'check_port'],
    ['a 501-character description', { ...nas, description: 'x'.repeat(501) }, 'description'],
    ['a numeric description', { ...nas, description: 7 }, 'description'],
    ['an entry that is a string', 'gpu-box', undefined],
    ['an entry that is null', null, undefined],
    ['an entry that is an array', [valid], undefined],
  ];

  it.each(INVALID_ENTRIES)(
    'refuses %s, naming the source, entry, alias, and field',
    async (_label, entry, field) => {
      const error = await configurationFailure(inline([valid, entry]));
      expect(error.message).toContain('WOL_HOSTS, entry 2 of 2');
      if (field !== undefined) expect(error.message).toContain(`field "${field}"`);
      // The alias is named only when the entry carries a well-formed one.
      if (field === undefined || field === 'alias') expect(error.message).not.toContain('(alias');
      else expect(error.message).toContain('(alias "nas")');
    },
  );

  it('names the file path as the source for a bad entry in WOL_HOSTS_FILE', async () => {
    const file = JSON.stringify([{ alias: 'nas', mac: 'nope' }]);
    const error = await configurationFailure(
      loadHostsConfig({ hostsFile: HOSTS_PATH }, fakeFs({ [HOSTS_PATH]: file }).deps),
    );
    expect(error.message).toContain(
      `WOL_HOSTS_FILE (${HOSTS_PATH}), entry 1 of 1 (alias "nas"), field "mac"`,
    );
  });

  it.each(['checkport', 'wolPort', 'secureOn'])(
    'refuses the unknown key %s by name (profiles are strict)',
    async (key) => {
      const error = await configurationFailure(inline([{ ...valid, [key]: 22 }]));
      expect(error.message).toContain('entry 1 of 1 (alias "gpu-box")');
      expect(error.message).toContain(key);
    },
  );

  it('refuses a duplicate alias, compared case-insensitively', async () => {
    const error = await configurationFailure(
      inline([valid, { ...valid, alias: 'nas' }, { ...valid, alias: 'GPU-Box' }]),
    );
    expect(error.message).toContain('entries 1 and 3');
    expect(error.message).toContain('GPU-Box');
  });

  it.each([
    ['a hostname address', { alias: 'nas', mac: MAC, address: 'nas.home.arpa' }],
    ['an IPv6 address', { alias: 'nas', mac: MAC, address: '2001:db8::50' }],
    ['no address', { alias: 'nas', mac: MAC }],
    ['a blank broadcast', { alias: 'nas', mac: MAC, address: 'nas.home.arpa', broadcast: '' }],
  ])(
    'refuses a profile with neither a broadcast nor an IPv4 address (%s)',
    async (_label, entry) => {
      const error = await configurationFailure(inline([entry]));
      expect(error.message).toContain('entry 1 of 1 (alias "nas")');
      expect(error.message).toContain('broadcast');
    },
  );
});

describe('loadHostsConfig — SecureOn values never reach an error', () => {
  const SECRET = { typed: '5E-C8-E7-0A-11-22', stored: '5e:c8:e7:0a:11:22', bare: '5ec8e70a1122' };
  const withSecret = { alias: 'nas', mac: MAC, address: '192.0.2.50', secureon: SECRET.typed };
  const MALFORMED_SECRETS = ['5E-C8-E7-0A-11', 'hunter2-hunter2', '5e:c8:e7:0a:11:22:33'];
  const json = (entries: unknown[]): ServerConfig => ({ hostsJson: JSON.stringify(entries) });

  const documents: ReadonlyArray<readonly [label: string, config: ServerConfig]> = [
    ['a JSON syntax error after the password', { hostsJson: `[${JSON.stringify(withSecret)},]` }],
    [
      'a JSON syntax error inside the password entry',
      { hostsJson: `[{"alias":"nas","secureon":"${SECRET.typed}",}]` },
    ],
    ['a bad MAC beside the password', json([{ ...withSecret, mac: 'nope' }])],
    ['an unknown key beside the password', json([{ ...withSecret, checkport: 22 }])],
    ['a duplicate alias carrying the password', json([withSecret, withSecret])],
    ['no broadcast beside the password', json([{ ...withSecret, address: 'nas.home.arpa' }])],
    ['a bad broadcast beside the password', json([{ ...withSecret, broadcast: '0.0.0.0' }])],
    ...MALFORMED_SECRETS.map(
      (secureon) =>
        [`the malformed password ${secureon}`, json([{ ...withSecret, secureon }])] as const,
    ),
  ];

  it.each(documents)('keeps the password out of the error for %s', async (_label, config) => {
    const error = await configurationFailure(loadHostsConfig(config, fakeFs().deps));
    const surfaces = [error.message, JSON.stringify(error.data ?? null), String(error.cause ?? '')];
    for (const text of surfaces) {
      for (const secret of [SECRET.typed, SECRET.stored, SECRET.bare, ...MALFORMED_SECRETS]) {
        expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    }
  });

  it('keeps the password out of a file-sourced JSON error too', async () => {
    const error = await configurationFailure(
      loadHostsConfig(
        { hostsFile: HOSTS_PATH },
        fakeFs({ [HOSTS_PATH]: `[${JSON.stringify(withSecret)}` }).deps,
      ),
    );
    expect(error.message.toLowerCase()).not.toContain(SECRET.typed.toLowerCase());
  });
});
