/**
 * @fileoverview Text helpers for the tools' `content[]` rendering and the
 * guidance they share.
 * @module mcp-server/tools/text
 */

import { isIPv6 } from 'node:net';

/** `address:port`, bracketing an IPv6 literal so the port stays unambiguous. */
export function hostPort(address: string, port: number): string {
  return isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`;
}

/** Flatten CR/LF to a space so an OS- or operator-supplied value stays on its inline line. */
export function flattenLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

/** Render text as a markdown blockquote, every line prefixed `> `. */
export function blockquote(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Guidance for a `refused` probe: the machine is on, and nothing listens on the check port. */
export function refusedGuidance(address: string, port: number): string {
  return `${address} answered but refused port ${port}: the machine is on, and nothing is listening on that port yet. If the service should be up, confirm the profile's check_port with wol_list_hosts.`;
}
