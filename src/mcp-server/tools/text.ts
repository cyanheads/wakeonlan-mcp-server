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

/**
 * Flatten line breaks to a space so an OS- or operator-supplied value stays on
 * its inline line. A line break is any Unicode mandatory break (UAX #14): CR,
 * LF, CRLF, VT, FF, NEL, LS, or PS; a renderer, or a model reading the text,
 * can start a new line at any of them.
 */
export function flattenLine(text: string): string {
  return text.replace(/[\n\v\f\r\u{85}\u{2028}\u{2029}]+/gu, ' ');
}

/** Render text as a markdown blockquote, `> ` before every line, splitting at the breaks {@link flattenLine} flattens. */
export function blockquote(text: string): string {
  return text
    .split(/\r\n|[\n\v\f\r\u{85}\u{2028}\u{2029}]/u)
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Guidance for a `refused` probe: the machine is on, and nothing listens on the check port. */
export function refusedGuidance(address: string, port: number): string {
  return `${address} answered but refused port ${port}: the machine is on, and nothing is listening on that port yet. If the service should be up, confirm the profile's check_port with wol_list_hosts.`;
}
