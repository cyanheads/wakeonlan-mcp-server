/**
 * @fileoverview `assertSafeHttpExposure` guard table: stdio always serves;
 * HTTP on loopback serves unless unauthenticated with wildcard origins; HTTP on
 * any other bind serves only with jwt/oauth and the dev auth bypass off.
 * @module tests/config/http-exposure.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { assertSafeHttpExposure, type HttpExposureConfig } from '@/config/http-exposure.js';

const config = (overrides: Partial<HttpExposureConfig>): HttpExposureConfig => ({
  mcpTransportType: 'http',
  mcpHttpHost: '127.0.0.1',
  mcpAuthMode: 'none',
  devMcpAuthBypass: false,
  ...overrides,
});

function refusal(input: HttpExposureConfig): McpError {
  try {
    assertSafeHttpExposure(input);
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    return error as McpError;
  }
  throw new Error(`Expected a refusal for ${JSON.stringify(input)}`);
}

const LOOPBACK_HOSTS = [
  '127.0.0.1',
  '127.8.9.10',
  '127.255.255.254',
  'localhost',
  'LOCALHOST',
  '::1',
  '[::1]',
];
const EXPOSED_HOSTS = [
  '0.0.0.0',
  '::',
  '[::]',
  '192.0.2.10',
  '128.0.0.1',
  '126.255.255.255',
  'localhost.example.com',
  '127.0.0.1.nip.io',
  'wol.home.arpa',
];

describe('assertSafeHttpExposure — stdio', () => {
  it.each([
    config({ mcpTransportType: 'stdio', mcpHttpHost: '0.0.0.0' }),
    config({ mcpTransportType: 'stdio', mcpHttpHost: '0.0.0.0', mcpAllowedOrigins: ['*'] }),
    config({ mcpTransportType: 'stdio', devMcpAuthBypass: true, mcpAllowedOrigins: ['*'] }),
  ])('serves stdio regardless of HTTP settings (%#)', (input) => {
    expect(() => assertSafeHttpExposure(input)).not.toThrow();
  });
});

describe('assertSafeHttpExposure — HTTP on loopback', () => {
  it.each(LOOPBACK_HOSTS)('serves unauthenticated on %s with MCP_ALLOWED_ORIGINS unset', (host) => {
    expect(() => assertSafeHttpExposure(config({ mcpHttpHost: host }))).not.toThrow();
  });

  it('serves unauthenticated with an explicit origin list', () => {
    expect(() =>
      assertSafeHttpExposure(
        config({ mcpAllowedOrigins: ['https://app.example.com', 'http://localhost:5173'] }),
      ),
    ).not.toThrow();
  });

  it.each([[['*']], [['https://app.example.com', '*']]])(
    'refuses unauthenticated with wildcard origins %j',
    (origins) => {
      const error = refusal(config({ mcpAllowedOrigins: origins }));
      expect(error.message).toContain('MCP_ALLOWED_ORIGINS');
      expect(error.message).toContain('MCP_AUTH_MODE');
    },
  );

  it.each(['jwt', 'oauth'] as const)(
    'serves wildcard origins when authenticated with %s',
    (mode) => {
      expect(() =>
        assertSafeHttpExposure(config({ mcpAuthMode: mode, mcpAllowedOrigins: ['*'] })),
      ).not.toThrow();
    },
  );

  it('treats jwt with the dev auth bypass on as unauthenticated', () => {
    refusal(config({ mcpAuthMode: 'jwt', devMcpAuthBypass: true, mcpAllowedOrigins: ['*'] }));
    expect(() =>
      assertSafeHttpExposure(config({ mcpAuthMode: 'jwt', devMcpAuthBypass: true })),
    ).not.toThrow();
  });
});

describe('assertSafeHttpExposure — HTTP on any other bind', () => {
  it.each(EXPOSED_HOSTS)('refuses unauthenticated on %s, naming the host', (host) => {
    const error = refusal(config({ mcpHttpHost: host }));
    expect(error.message).toContain(host);
    expect(error.message).toContain('MCP_HTTP_HOST');
    expect(error.message).toContain('MCP_AUTH_MODE');
  });

  it.each(['jwt', 'oauth'] as const)('serves 0.0.0.0 when authenticated with %s', (mode) => {
    expect(() =>
      assertSafeHttpExposure(config({ mcpHttpHost: '0.0.0.0', mcpAuthMode: mode })),
    ).not.toThrow();
    expect(() =>
      assertSafeHttpExposure(
        config({ mcpHttpHost: '::', mcpAuthMode: mode, mcpAllowedOrigins: ['*'] }),
      ),
    ).not.toThrow();
  });

  it.each(['jwt', 'oauth'] as const)('refuses %s with the dev auth bypass on', (mode) => {
    const error = refusal(
      config({ mcpHttpHost: '0.0.0.0', mcpAuthMode: mode, devMcpAuthBypass: true }),
    );
    expect(error.message).toContain('0.0.0.0');
  });

  it('reports the exposed bind before the wildcard origins when both apply', () => {
    const error = refusal(config({ mcpHttpHost: '0.0.0.0', mcpAllowedOrigins: ['*'] }));
    expect(error.message).toContain('0.0.0.0');
    expect(error.message).toContain('MCP_HTTP_HOST');
  });
});
