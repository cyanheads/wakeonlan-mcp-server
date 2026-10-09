/**
 * @fileoverview wol_wake_host — send Wake-on-LAN magic packets to a configured
 * host, then wait for its TCP check port to answer.
 * @module mcp-server/tools/definitions/wake-host.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getHostRegistry } from '@/services/hosts/host-registry.js';
import { getLanService, PACKET_COUNT, POLL_INTERVAL_MS } from '@/services/lan/lan-service.js';
import type { WakeResult } from '@/services/lan/types.js';
import { aliasInput, NO_PROFILES_HINT, unknownHostDetails } from '../host-alias.js';
import { blockquote, flattenLine, hostPort, refusedGuidance } from '../text.js';

const MAX_WAIT_S = 55;
const DEFAULT_WAIT_S = 30;
const POLL_INTERVAL_S = POLL_INTERVAL_MS / 1000;

const DARWIN_SOCKET_HINT =
  'On macOS 15 and later, the user must allow Local Network access for the app that launched this server (System Settings > Privacy & Security > Local Network); the first send after that prompt appears can fail before it is answered. Retry wol_wake_host once access is allowed, and call wol_list_reference with topic sender-environment if it still fails.';

type SentResult = Extract<WakeResult, { kind: 'sent' }>;

/** Guidance for the states that leave the agent a next step. */
function wakeGuidance(
  result: SentResult,
  context: { broadcast: string; waitForS: number; wolPort: number },
): string | undefined {
  if (result.state === 'unverified') {
    return result.unverifiedReason === 'no_address'
      ? "Packets sent, but this host's profile has no address, so the wake cannot be confirmed. Add an address to the profile to enable confirmation; call wol_list_reference with topic host-profiles for the format."
      : 'Packets sent; no check was made because wait_for_s is 0. Call wol_check_host to confirm the host came up.';
  }
  if (result.state !== 'not_reachable' || !result.probe) return;
  const { address, port, last_outcome } = result.probe;
  if (last_outcome === 'refused') return refusedGuidance(address, port);
  return `Sent ${PACKET_COUNT} packets to ${context.broadcast}:${context.wolPort}, but ${hostPort(address, port)} did not answer within ${context.waitForS} s. A cold boot can take longer, so re-check with wol_check_host in a minute. If it never answers, call wol_list_reference with topic troubleshooting.`;
}

export const wolWakeHost = tool('wol_wake_host', {
  title: 'Wake Host',
  description: `Send Wake-on-LAN magic packets to a configured host and, by default, wait until it answers on its TCP check port. Name the host by its alias from wol_list_hosts; the MAC, broadcast address, and ports come from the operator's profile, and a host this machine has no interface on (on_segment false in wol_list_hosts) is refused before anything is sent. It probes the check port once, sends ${PACKET_COUNT} packets, then re-probes every ${POLL_INTERVAL_S} seconds until the port answers or wait_for_s elapses. The result state is already_awake (the port answered before the packets went out; they are still sent), awake (it answered within the window, with time_to_answer_ms), not_reachable (the window elapsed; the host may still be booting, so re-check with wol_check_host), or unverified (no probe ran: wait_for_s was 0, or the profile has no address).`,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  auth: ['wol:wake'],
  input: z.object({
    alias: aliasInput,
    wait_for_s: z
      .preprocess(
        (value) => (value === '' ? undefined : value),
        z.number().int().min(0).max(MAX_WAIT_S).default(DEFAULT_WAIT_S),
      )
      .describe(
        `Seconds to wait for the host's check port to answer after the first packet (0–${MAX_WAIT_S}, default ${DEFAULT_WAIT_S}). 0 sends and returns without checking. ${MAX_WAIT_S} is the cap so the whole call fits inside the 60-second request timeout many MCP clients apply; re-check a slow cold boot with wol_check_host.`,
      ),
  }),
  output: z.object({
    alias: z.string().describe('Canonical alias as configured.'),
    mac: z.string().describe('MAC address the packets carried, lowercase colon form.'),
    state: z
      .enum(['already_awake', 'awake', 'not_reachable', 'unverified'])
      .describe(
        'already_awake: the check port answered before the packets went out (they were still sent). awake: it answered within the window. not_reachable: the window elapsed without an answer; the host may still be booting. unverified: no probe ran (see unverified_reason).',
      ),
    unverified_reason: z
      .enum(['wait_disabled', 'no_address'])
      .optional()
      .describe(
        'Why no probe ran. wait_disabled: wait_for_s was 0. no_address: the profile has no address (reported when both apply). Present only when state is unverified.',
      ),
    packets_sent: z
      .number()
      .int()
      .describe(`Magic packets sent (always ${PACKET_COUNT} on a returned result).`),
    broadcast: z.string().describe('Broadcast address the packets went to.'),
    wol_port: z.number().int().describe('UDP destination port the packets were sent to.'),
    interface: z.string().describe('Local network interface the packets were sent from.'),
    local_address: z.string().describe('Local IPv4 address the socket bound to.'),
    secureon_set: z
      .boolean()
      .describe(
        "Whether the profile's SecureOn password was appended to the packets (never the password itself).",
      ),
    probe: z
      .object({
        address: z.string().describe('Host address probed, as configured (hostname or IP).'),
        port: z.number().int().describe("The profile's TCP check port."),
        attempts: z.number().int().describe('Probes made, counting the one before the packets.'),
        last_outcome: z
          .enum(['open', 'refused', 'no_answer'])
          .describe(
            'Outcome of the last probe. open: connected. refused: the machine answered but nothing listens on the port. no_answer: nothing answered within the probe timeout.',
          ),
      })
      .optional()
      .describe("Probes of the host's check port; present unless state is unverified."),
    time_to_answer_ms: z
      .number()
      .int()
      .optional()
      .describe(
        `Time from the first packet to the confirmation poll that connected, in ms. Polls run every ${POLL_INTERVAL_S} seconds, so this is an upper bound on when the check port started answering, not the exact moment. Present only when state is awake.`,
      ),
    elapsed_ms: z.number().int().describe('Wall-clock time for the whole call, in ms.'),
    guidance: z
      .string()
      .optional()
      .describe('Next step, present when state is not_reachable or unverified.'),
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
      reason: 'off_segment',
      code: JsonRpcErrorCode.ConfigurationError,
      when: "The profile's broadcast address (configured or derived) is not the directed broadcast of any local interface, or no broadcast can be derived. Nothing is sent.",
      severity: 'warning',
      recovery:
        "Nothing was sent: this machine has no network interface on the host's subnet. Call wol_check_host to see whether the host is already awake. Waking it needs the server on a machine attached to that LAN, or a corrected broadcast in the profile; wol_list_reference with topic sender-environment covers the WSL2, VPN, and container setups that cause this.",
    },
    {
      reason: 'wake_in_progress',
      code: JsonRpcErrorCode.Conflict,
      when: 'Another wol_wake_host call for the same host is still running; one wake per host runs at a time. Nothing is sent.',
      retryable: true,
      severity: 'notice',
      recovery:
        'Another wol_wake_host call for this host is still running and returns within a minute. Call wol_check_host to see whether the host is up, or retry wol_wake_host once that call has returned.',
    },
    {
      reason: 'socket_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Binding the UDP socket, enabling broadcast, or sending a packet failed. A partial send fails the call too; the error data carries how many packets went out.',
      retryable: true,
      recovery:
        'The local network stack refused the UDP send. Retry wol_wake_host once; if it fails again, call wol_list_reference with topic sender-environment for the platform permissions and network setups that block a broadcast send.',
    },
  ],

  async handler(input, ctx) {
    const lan = getLanService();
    const startedAt = lan.now();
    const registry = getHostRegistry();

    const profile = registry.find(input.alias);
    if (!profile) {
      const { message, data } = unknownHostDetails(input.alias, registry);
      throw ctx.fail('unknown_host', message, {
        ...data,
        ...(data.configured_count === 0 && { recovery: { hint: NO_PROFILES_HINT } }),
      });
    }
    const { alias } = profile;

    const segment = lan.resolveSegment(profile);
    if (!segment.ok) {
      const subnets =
        segment.localSubnets.map((s) => `${flattenLine(s.interface)} ${s.cidr}`).join(', ') ||
        'none';
      const problem =
        segment.broadcast !== undefined
          ? `Broadcast ${segment.broadcast} for "${alias}" is not the directed broadcast of any local interface.`
          : `No broadcast for "${alias}" could be derived from its address ${profile.address}: it is not inside any local IPv4 subnet.`;
      throw ctx.fail('off_segment', `${problem} Local IPv4 subnets compared: ${subnets}.`, {
        alias,
        ...(segment.broadcast !== undefined && { broadcast: segment.broadcast }),
        local_subnets: segment.localSubnets,
      });
    }

    const result = await lan.wake(profile, segment, input.wait_for_s, ctx.signal);
    if (result.kind === 'in_progress') {
      throw ctx.fail(
        'wake_in_progress',
        `A wake of "${alias}" is already running; only one wake of a host runs at a time, and nothing was sent.`,
        { alias },
      );
    }
    if (result.kind === 'send_failed') {
      throw ctx.fail(
        'socket_error',
        `The UDP send failed at ${result.stage} after ${result.packetsSent} of ${PACKET_COUNT} packets${result.code !== undefined ? `: ${result.code}` : ''}.`,
        {
          alias,
          stage: result.stage,
          packets_sent: result.packetsSent,
          packets_planned: PACKET_COUNT,
          ...(result.code !== undefined && { code: result.code }),
          ...(lan.platform === 'darwin' && { recovery: { hint: DARWIN_SOCKET_HINT } }),
        },
      );
    }

    const guidance = wakeGuidance(result, {
      broadcast: segment.broadcast,
      waitForS: input.wait_for_s,
      wolPort: profile.wol_port,
    });
    ctx.log.info('Wake finished', { alias, state: result.state, attempts: result.probe?.attempts });

    return {
      alias,
      mac: profile.mac,
      state: result.state,
      ...(result.unverifiedReason !== undefined && { unverified_reason: result.unverifiedReason }),
      packets_sent: PACKET_COUNT,
      broadcast: segment.broadcast,
      wol_port: profile.wol_port,
      interface: segment.interface,
      local_address: segment.localAddress,
      secureon_set: profile.secureon !== undefined,
      ...(result.probe !== undefined && { probe: result.probe }),
      ...(result.timeToAnswerMs !== undefined && { time_to_answer_ms: result.timeToAnswerMs }),
      elapsed_ms: Math.round(lan.now() - startedAt),
      ...(guidance !== undefined && { guidance }),
    };
  },

  format: (result) => {
    const lines = [`## ${result.alias}: ${result.state}`];
    if (result.unverified_reason !== undefined) {
      lines.push(`- **Unverified reason:** ${result.unverified_reason}`);
    }
    if (result.probe !== undefined) {
      const { address, port, attempts, last_outcome } = result.probe;
      const connected =
        result.time_to_answer_ms !== undefined
          ? `, poll connected ${result.time_to_answer_ms} ms after the first packet (an upper bound on when the port came up; polls run every ${POLL_INTERVAL_S} s)`
          : '';
      lines.push(
        `- **Probe:** ${hostPort(address, port)} (TCP), ${attempts} attempt${attempts === 1 ? '' : 's'}, last outcome ${last_outcome}${connected}`,
      );
    }
    lines.push(
      `- **Packets:** ${result.packets_sent} → ${result.broadcast}:${result.wol_port} via ${flattenLine(result.interface)} (${result.local_address}), secureon_set: ${result.secureon_set ? 'yes' : 'no'}`,
      `- **MAC:** ${result.mac}`,
      `- **Elapsed:** ${result.elapsed_ms} ms`,
    );
    if (result.guidance !== undefined) lines.push('', blockquote(result.guidance));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
