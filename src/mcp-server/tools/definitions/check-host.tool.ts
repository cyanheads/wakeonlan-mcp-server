/**
 * @fileoverview wol_check_host — one TCP probe of a configured host's check
 * port, without sending a magic packet.
 * @module mcp-server/tools/definitions/check-host.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getHostRegistry } from '@/services/hosts/host-registry.js';
import { getLanService, PROBE_TIMEOUT_MS } from '@/services/lan/lan-service.js';
import { aliasInput, NO_PROFILES_HINT, unknownHostDetails } from '../host-alias.js';
import { blockquote, hostPort, refusedGuidance } from '../text.js';

const PROBE_TIMEOUT_S = PROBE_TIMEOUT_MS / 1000;

export const wolCheckHost = tool('wol_check_host', {
  title: 'Check Host',
  description: `Check whether a configured host is up right now by opening one TCP connection to its check port (22 unless the profile sets another) and closing it; sends no Wake-on-LAN packet. Name the host by its alias from wol_list_hosts; its profile must include an address. The outcome is open (reachable), refused (the machine answered but nothing listens on that port), or no_answer (nothing answered within ${PROBE_TIMEOUT_S} seconds). Use it to re-check a host after wol_wake_host returns not_reachable or unverified.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['wol:read'],
  input: z.object({ alias: aliasInput }),
  output: z.object({
    alias: z.string().describe('Canonical alias as configured.'),
    address: z.string().describe('Address probed, as configured (hostname or IP).'),
    check_port: z.number().int().describe("TCP port probed: the profile's check_port."),
    reachable: z.boolean().describe('True only when the connection opened (outcome open).'),
    outcome: z
      .enum(['open', 'refused', 'no_answer'])
      .describe(
        `open: connected. refused: the machine answered but nothing listens on the port. no_answer: nothing answered within ${PROBE_TIMEOUT_S} s.`,
      ),
    latency_ms: z
      .number()
      .int()
      .optional()
      .describe('Connect start to answer, in ms; present for open and refused.'),
    guidance: z.string().optional().describe('Next step, present for refused and no_answer.'),
  }),
  errors: [
    {
      reason: 'unknown_host',
      code: JsonRpcErrorCode.NotFound,
      when: 'The alias matches no configured profile.',
      severity: 'notice',
      recovery:
        'No host profile has that alias. Retry with one of the configured aliases this error lists, or call wol_list_hosts for the full list; a profile added after the server started loads only after a restart.',
    },
    {
      reason: 'no_address',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The profile has no address, so there is nothing to probe.',
      severity: 'notice',
      recovery:
        "This host's profile has no address to probe. wol_wake_host can still send it packets, unverified. Confirming it needs an address added to the profile and a server restart; wol_list_reference with topic host-profiles has the format.",
    },
  ],

  async handler(input, ctx) {
    const registry = getHostRegistry();
    const profile = registry.find(input.alias);
    if (!profile) {
      const { message, data } = unknownHostDetails(input.alias, registry);
      throw ctx.fail('unknown_host', message, {
        ...data,
        ...(data.configured_count === 0
          ? { recovery: { hint: NO_PROFILES_HINT } }
          : ctx.recoveryFor('unknown_host')),
      });
    }
    const { alias, address, check_port } = profile;
    if (address === undefined) {
      throw ctx.fail('no_address', `The profile for "${alias}" has no address to probe.`, {
        alias,
        ...ctx.recoveryFor('no_address'),
      });
    }

    const lan = getLanService();
    const result = await lan.probe(address, check_port, PROBE_TIMEOUT_MS, ctx.signal);
    ctx.log.info('Probed host', { alias, check_port, outcome: result.outcome });

    let guidance: string | undefined;
    if (result.outcome === 'refused') guidance = refusedGuidance(address, check_port);
    if (result.outcome === 'no_answer') {
      guidance = `Nothing answered on ${hostPort(address, check_port)} within ${PROBE_TIMEOUT_S} s. If the machine is asleep, wake it with wol_wake_host; if you just woke it, re-check in a moment.`;
      if (lan.platform === 'darwin') {
        guidance +=
          ' On macOS 15 and later, a denied Local Network permission for the app that launched this server looks the same; call wol_list_reference with topic sender-environment.';
      }
    }

    return {
      alias,
      address,
      check_port,
      reachable: result.outcome === 'open',
      outcome: result.outcome,
      ...(result.outcome !== 'no_answer' && { latency_ms: result.latencyMs }),
      ...(guidance !== undefined && { guidance }),
    };
  },

  format: (result) => {
    const lines = [
      `## ${result.alias}: ${result.outcome}`,
      `- **Probed:** ${hostPort(result.address, result.check_port)} (TCP)`,
      `- **reachable:** ${result.reachable ? 'yes' : 'no'}`,
    ];
    if (result.latency_ms !== undefined) lines.push(`- **Latency:** ${result.latency_ms} ms`);
    if (result.guidance !== undefined) lines.push('', blockquote(result.guidance));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
