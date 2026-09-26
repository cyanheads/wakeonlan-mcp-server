/**
 * @fileoverview MAC-format parsing for host profiles: the target's MAC address
 * and the optional 6-byte SecureOn password share one textual parser.
 * @module services/hosts/mac
 */

/** Why a MAC-format value was rejected. */
export type MacRejection = 'format' | 'group' | 'zero';

export type MacParseResult = { ok: true; value: string } | { ok: false; reason: MacRejection };

const SEPARATED_COLON = /^[0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5}$/i;
const SEPARATED_DASH = /^[0-9a-f]{1,2}(?:-[0-9a-f]{1,2}){5}$/i;
const CISCO_DOTTED = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i;
const BARE = /^[0-9a-f]{12}$/i;

/**
 * Six groups of 1–2 hex digits joined by one separator (all colons or all
 * dashes, zero-padded), Cisco dotted (three groups of 4), or 12 bare hex digits.
 * Returns the six bytes as lowercase hex pairs, or `undefined` for anything else.
 */
function parseSixBytes(text: string): string[] | undefined {
  if (SEPARATED_COLON.test(text) || SEPARATED_DASH.test(text)) {
    return text.split(/[:-]/).map((group) => group.padStart(2, '0').toLowerCase());
  }
  if (CISCO_DOTTED.test(text) || BARE.test(text)) {
    const hex = text.replaceAll('.', '').toLowerCase();
    return Array.from({ length: 6 }, (_, i) => hex.slice(i * 2, i * 2 + 2));
  }
  return;
}

/**
 * Parse a target MAC address into lowercase colon form. Rejects group
 * (multicast/broadcast) addresses and all zeros: no NIC owns either, so a magic
 * packet for one wakes nothing.
 */
export function parseMac(text: string): MacParseResult {
  const bytes = parseSixBytes(text);
  if (!bytes) return { ok: false, reason: 'format' };
  if (bytes.every((b) => b === '00')) return { ok: false, reason: 'zero' };
  if (Number.parseInt(bytes[0] ?? '00', 16) & 1) return { ok: false, reason: 'group' };
  return { ok: true, value: bytes.join(':') };
}

/**
 * Parse a SecureOn password into lowercase colon form. Any 6 bytes are valid:
 * a password has no address semantics, so the MAC's group-bit and all-zero
 * rejections do not apply.
 */
export function parseSecureOn(text: string): MacParseResult {
  const bytes = parseSixBytes(text);
  return bytes ? { ok: true, value: bytes.join(':') } : { ok: false, reason: 'format' };
}

/** Convert lowercase colon form (`00:00:5e:00:53:01`) to its 6 raw bytes. */
export function macToBytes(mac: string): Buffer {
  return Buffer.from(mac.replaceAll(':', ''), 'hex');
}
