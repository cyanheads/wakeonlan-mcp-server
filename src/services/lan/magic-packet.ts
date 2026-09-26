/**
 * @fileoverview Wake-on-LAN magic packet construction: 6 bytes of 0xFF, the
 * target MAC repeated 16 times, and an optional 6-byte SecureOn password.
 * @module services/lan/magic-packet
 */

import { macToBytes } from '@/services/hosts/mac.js';

const SYNC_STREAM_LENGTH = 6;
const MAC_REPETITIONS = 16;
const MAC_LENGTH = 6;

/**
 * Build the magic packet for a MAC in lowercase colon form: 102 bytes, or 108
 * with a SecureOn password appended.
 */
export function buildMagicPacket(mac: string, secureon?: string): Buffer {
  const macBytes = macToBytes(mac);
  const body = SYNC_STREAM_LENGTH + MAC_REPETITIONS * MAC_LENGTH;
  const packet = Buffer.alloc(body + (secureon ? MAC_LENGTH : 0), 0xff);
  for (let i = 0; i < MAC_REPETITIONS; i++) {
    macBytes.copy(packet, SYNC_STREAM_LENGTH + i * MAC_LENGTH);
  }
  if (secureon) macToBytes(secureon).copy(packet, body);
  return packet;
}
