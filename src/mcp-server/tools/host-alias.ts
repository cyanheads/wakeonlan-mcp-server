/**
 * @fileoverview The `alias` input shared by the per-host tools, and the
 * `unknown_host` failure details built from the configured profile set.
 * @module mcp-server/tools/host-alias
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { HostRegistry } from '@/services/hosts/host-registry.js';
import { ALIAS_PATTERN } from '@/services/hosts/hosts-config.js';

const LISTED_ALIASES = 20;

/** Recovery hint for `unknown_host` when no profiles are configured at all. */
export const NO_PROFILES_HINT =
  'No host profiles are configured, so there is nothing to wake or check until the operator sets WOL_HOSTS_FILE or WOL_HOSTS and restarts the server. Call wol_list_reference with topic host-profiles for the format.';

export const aliasInput = z
  .string()
  .regex(
    ALIAS_PATTERN,
    'An alias starts with a letter or digit and uses only letters, digits, ".", "_", or "-" (1–64 characters).',
  )
  .describe('Host alias from wol_list_hosts (case-insensitive).');

/** Message and data for an alias that matches no profile; lists up to 20 configured aliases. */
export function unknownHostDetails(alias: string, registry: HostRegistry) {
  const configured = registry.profiles.map((p) => p.alias);
  const listed = configured.slice(0, LISTED_ALIASES);
  const more = configured.length - listed.length;
  const message =
    configured.length === 0
      ? `No host profile has the alias "${alias}": no host profiles are configured.`
      : `No host profile has the alias "${alias}". Configured aliases: ${listed.join(', ')}${more > 0 ? `, … and ${more} more` : ''}.`;
  return {
    message,
    data: { alias, configured_aliases: listed, configured_count: configured.length },
  };
}
