/**
 * @fileoverview Magic packet bytes: exact 102-byte and 108-byte (SecureOn)
 * vectors, compared against packets spelled out from hex.
 * @module tests/services/lan/magic-packet.test
 */

import { describe, expect, it } from 'vitest';
import { buildMagicPacket } from '@/services/lan/magic-packet.js';
import { magicPacketHex } from '../../helpers/fixtures.js';

describe('buildMagicPacket', () => {
  it('builds the 102-byte packet: 6 × 0xFF, then the MAC 16 times', () => {
    const packet = buildMagicPacket('00:00:5e:00:53:01');
    expect(packet).toHaveLength(102);
    expect(packet.equals(magicPacketHex('00005e005301'))).toBe(true);
    expect([...packet.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    for (let i = 0; i < 16; i++) {
      const offset = 6 + i * 6;
      expect(packet.subarray(offset, offset + 6).toString('hex')).toBe('00005e005301');
    }
  });

  it('appends a SecureOn password for a 108-byte packet', () => {
    const packet = buildMagicPacket('00:00:5e:00:53:01', 'a1:b2:c3:d4:e5:f6');
    expect(packet).toHaveLength(108);
    expect(packet.equals(magicPacketHex('00005e005301', 'a1b2c3d4e5f6'))).toBe(true);
    expect(packet.subarray(102).toString('hex')).toBe('a1b2c3d4e5f6');
  });

  it('carries a SecureOn password that is all 0xFF or all zeros byte for byte', () => {
    expect(buildMagicPacket('02:00:5e:10:00:01', 'ff:ff:ff:ff:ff:ff').subarray(102)).toEqual(
      Buffer.alloc(6, 0xff),
    );
    expect(buildMagicPacket('02:00:5e:10:00:01', '00:00:00:00:00:00').subarray(102)).toEqual(
      Buffer.alloc(6, 0x00),
    );
  });

  it('encodes MAC bytes of 0xFF inside the repetitions without disturbing the sync stream', () => {
    const packet = buildMagicPacket('fe:ff:ff:ff:ff:ff');
    expect(packet.equals(magicPacketHex('feffffffffff'))).toBe(true);
  });
});
