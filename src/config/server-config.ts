/**
 * @fileoverview Server-specific configuration: where the operator's host
 * profiles come from. Lazy-parsed from the environment; framework config
 * (transport, auth, logging) is handled by @cyanheads/mcp-ts-core.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  hostsFile: z
    .string()
    .optional()
    .describe(
      'Absolute path to the JSON hosts file; a leading ~/ expands to the home directory. Mutually exclusive with WOL_HOSTS.',
    ),
  hostsJson: z
    .string()
    .optional()
    .describe('The hosts document as inline JSON. Mutually exclusive with WOL_HOSTS_FILE.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Parse the server's env vars once; a blank value reads as unset. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    hostsFile: 'WOL_HOSTS_FILE',
    hostsJson: 'WOL_HOSTS',
  });
  return _config;
}
