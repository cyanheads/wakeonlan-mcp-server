/**
 * @fileoverview Startup guard that refuses an HTTP deployment which would let an
 * unauthenticated caller reach the Wake-on-LAN tools from beyond this machine,
 * or from a web page through the user's browser.
 * @module config/http-exposure
 */

import { isIPv4 } from 'node:net';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';

/** The slice of framework config the guard reads. */
export type HttpExposureConfig = Pick<
  AppConfig,
  'mcpTransportType' | 'mcpHttpHost' | 'mcpAuthMode' | 'devMcpAuthBypass' | 'mcpAllowedOrigins'
>;

/** `localhost`, any `127.0.0.0/8` address, or `::1` (bracketed or bare). */
function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  return isIPv4(normalized) && normalized.startsWith('127.');
}

/**
 * Throws a `ConfigurationError` when the HTTP transport would serve without
 * authentication on a non-loopback bind, or on a loopback bind with
 * `MCP_ALLOWED_ORIGINS` wildcarded (which turns off DNS-rebinding protection).
 * Stdio always passes.
 */
export function assertSafeHttpExposure(config: HttpExposureConfig): void {
  if (config.mcpTransportType !== 'http') return;

  const authenticated =
    (config.mcpAuthMode === 'jwt' || config.mcpAuthMode === 'oauth') && !config.devMcpAuthBypass;
  if (authenticated) return;

  if (!isLoopbackHost(config.mcpHttpHost)) {
    throw configurationError(
      `Refusing to serve Wake-on-LAN over HTTP on ${config.mcpHttpHost} without authentication. Bind MCP_HTTP_HOST to 127.0.0.1, or set MCP_AUTH_MODE to jwt or oauth.`,
    );
  }

  if (config.mcpAllowedOrigins?.includes('*')) {
    throw configurationError(
      "Refusing to serve Wake-on-LAN over HTTP without authentication while MCP_ALLOWED_ORIGINS is '*', which turns off DNS-rebinding protection. Unset MCP_ALLOWED_ORIGINS, or set MCP_AUTH_MODE to jwt or oauth.",
    );
  }
}
