/**
 * @fileoverview Loads and validates the operator's host profiles from
 * `WOL_HOSTS_FILE` or `WOL_HOSTS` once at startup. Every failure is a
 * `ConfigurationError` naming the source, entry, alias, and field; no message
 * ever echoes a SecureOn value.
 * @module services/hosts/hosts-config
 */

import { readFile } from 'node:fs/promises';
import { isIP, isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';
import { type MacRejection, parseMac, parseSecureOn } from './mac.js';
import type { HostProfile, LoadedHosts } from './types.js';

/** Host alias charset: shared by the hosts file and every tool's `alias` input. */
export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** OS reads the loader takes as parameters so tests never touch the real filesystem. */
export interface HostsConfigDeps {
  homedir(): string;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

const defaultDeps: HostsConfigDeps = { readFile, homedir };

const MAC_FORMATS = '00:00:5e:00:53:01 (colons or dashes), 0000.5e00.5301, or 00005e005301';

const MAC_REJECTIONS: Record<MacRejection, string> = {
  format: `must be six hex bytes: ${MAC_FORMATS}`,
  group: "is a group (multicast) address; use the target NIC's own unicast MAC",
  zero: "is all zeros; use the target NIC's own MAC",
};

const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** IPv4 or IPv6 literal, or a DNS hostname of dot-separated `[A-Za-z0-9-]` labels. */
function isValidAddress(value: string): boolean {
  if (isIP(value) !== 0) return true;
  const name = value.endsWith('.') ? value.slice(0, -1) : value;
  return (
    name.length > 0 && name.length <= 253 && name.split('.').every((l) => HOSTNAME_LABEL.test(l))
  );
}

/** Rejects the limited broadcast, the unspecified address, and multicast (224.0.0.0/4). */
function isDirectedBroadcastCandidate(value: string): boolean {
  if (value === '255.255.255.255' || value === '0.0.0.0') return false;
  const firstOctet = Number(value.split('.')[0]);
  return firstOctet < 224 || firstOctet > 239;
}

/** A blank optional string from the hosts file means unset. */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const port = (fallback: number) => z.number().int().min(1).max(65535).default(fallback);

const HostProfileSchema = z.strictObject({
  alias: z
    .string()
    .regex(
      ALIAS_PATTERN,
      'must start with a letter or digit and use only letters, digits, ".", "_", or "-" (1–64 characters)',
    ),
  mac: z.string().transform((text, ctx) => {
    const parsed = parseMac(text);
    if (parsed.ok) return parsed.value;
    ctx.addIssue({ code: 'custom', message: MAC_REJECTIONS[parsed.reason] });
    return z.NEVER;
  }),
  address: blankAsUnset(
    z
      .string()
      .refine(
        isValidAddress,
        'must be an IPv4 or IPv6 literal, or a DNS hostname (dot-separated labels of letters, digits, and inner hyphens, 253 characters at most)',
      )
      .optional(),
  ),
  broadcast: blankAsUnset(
    z
      .string()
      .refine(isIPv4, 'must be an IPv4 dotted quad, e.g. 192.0.2.255')
      .refine(
        isDirectedBroadcastCandidate,
        "must be the target subnet's directed broadcast; 255.255.255.255, 0.0.0.0, and multicast (224.0.0.0/4) are rejected",
      )
      .optional(),
  ),
  wol_port: port(9),
  check_port: port(22),
  secureon: blankAsUnset(
    z
      .string()
      .transform((text, ctx) => {
        const parsed = parseSecureOn(text);
        if (parsed.ok) return parsed.value;
        ctx.addIssue({ code: 'custom', message: `must be 6 bytes in MAC format: ${MAC_FORMATS}` });
        return z.NEVER;
      })
      .optional(),
  ),
  description: blankAsUnset(z.string().max(500).optional()),
});

/** Parse JSON without surfacing the parser's message, which can quote a SecureOn value. */
function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw configurationError(`${label} is not valid JSON.`);
  }
}

/** Resolve `WOL_HOSTS_FILE`, expanding a leading `~/` and requiring an absolute path. */
function resolveHostsPath(raw: string, deps: HostsConfigDeps): string {
  const expanded = raw.startsWith('~/') ? join(deps.homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) {
    throw configurationError(
      `WOL_HOSTS_FILE (${raw}) must be an absolute path (a leading ~/ is expanded). A relative path would resolve against the MCP client's working directory.`,
    );
  }
  return expanded;
}

function entryLabel(entry: unknown, index: number, total: number): string {
  const alias = (entry as { alias?: unknown } | null)?.alias;
  const named = typeof alias === 'string' && ALIAS_PATTERN.test(alias) ? ` (alias "${alias}")` : '';
  return `entry ${index + 1} of ${total}${named}`;
}

/** Validate the parsed document into profiles; throws on the first problem. */
function validateProfiles(document: unknown, label: string): HostProfile[] {
  if (!Array.isArray(document)) {
    throw configurationError(`${label} must be a JSON array of host profiles.`);
  }

  const profiles: HostProfile[] = [];
  const seen = new Map<string, number>();

  for (const [index, entry] of document.entries()) {
    const where = `${label}, ${entryLabel(entry, index, document.length)}`;
    const parsed = HostProfileSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.length ? `, field "${issue.path.join('.')}"` : '';
      throw configurationError(`${where}${field}: ${issue?.message ?? 'invalid profile'}.`);
    }

    const { description, address, broadcast, secureon, ...required } = parsed.data;
    const profile: HostProfile = {
      ...required,
      ...(description !== undefined && { description }),
      ...(address !== undefined && { address }),
      ...(broadcast !== undefined && { broadcast }),
      ...(secureon !== undefined && { secureon }),
    };

    const key = profile.alias.toLowerCase();
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw configurationError(
        `${label}: entries ${earlier + 1} and ${index + 1} both use the alias "${profile.alias}" (aliases are case-insensitive).`,
      );
    }
    seen.set(key, index);

    if (!profile.broadcast && !(profile.address && isIPv4(profile.address))) {
      throw configurationError(
        `${where}: set "broadcast", or set "address" to an IPv4 literal so the broadcast can be derived from the matching local interface.`,
      );
    }

    profiles.push(profile);
  }
  return profiles;
}

/**
 * Load the host profiles from `WOL_HOSTS_FILE` (a JSON file) or `WOL_HOSTS`
 * (inline JSON). Neither set is a valid start with zero profiles.
 */
export async function loadHostsConfig(
  config: ServerConfig,
  deps: HostsConfigDeps = defaultDeps,
): Promise<LoadedHosts> {
  if (config.hostsFile && config.hostsJson) {
    throw configurationError(
      'Set either WOL_HOSTS_FILE or WOL_HOSTS, not both: the two are mutually exclusive sources of host profiles.',
    );
  }

  if (config.hostsFile) {
    const path = resolveHostsPath(config.hostsFile, deps);
    const label = `WOL_HOSTS_FILE (${path})`;
    let text: string;
    try {
      text = await deps.readFile(path, 'utf8');
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      throw configurationError(
        `${label} could not be read${typeof code === 'string' ? ` (${code})` : ''}.`,
        undefined,
        { cause: err },
      );
    }
    // `readFile` keeps a UTF-8 byte-order mark, which `JSON.parse` rejects; Windows editors write one.
    const document = parseJson(text.replace(/^﻿/, ''), label);
    return { source: 'file', path, profiles: validateProfiles(document, label) };
  }

  if (config.hostsJson) {
    return {
      source: 'inline',
      profiles: validateProfiles(parseJson(config.hostsJson, 'WOL_HOSTS'), 'WOL_HOSTS'),
    };
  }

  return { source: 'none', profiles: [] };
}
