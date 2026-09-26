/**
 * @fileoverview Root Vitest setup file: a socket tripwire. Replaces the socket
 * factories and `Socket` constructors of `node:dgram` and `node:net` (named
 * exports and `default`) with functions that throw, so any code path that would
 * open a real socket fails loudly instead of touching the LAN. Everything else
 * in both modules (`isIP`, `isIPv4`, …) passes through untouched. Tests inject
 * `createUdpSocket` / `connectTcp` fakes through `initLanService()` instead.
 * @module tests/setup/socket-tripwire
 */

import { vi } from 'vitest';

const { tripwire } = vi.hoisted(() => {
  const message = 'Real socket opened in a test: inject createUdpSocket / connectTcp';
  /** A plain `function` (not an arrow) so `new Socket()` reaches the throw too. */
  function tripwire(): never {
    throw new Error(message);
  }
  return { tripwire };
});

/** A builtin's ESM namespace also carries the CommonJS module as `default`. */
type WithDefault<T> = T & { default: T };

vi.mock('node:dgram', async (importOriginal) => {
  const actual = await importOriginal<WithDefault<typeof import('node:dgram')>>();
  const blocked = { createSocket: tripwire, Socket: tripwire };
  return { ...actual, ...blocked, default: { ...actual.default, ...blocked } };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<WithDefault<typeof import('node:net')>>();
  const blocked = { connect: tripwire, createConnection: tripwire, Socket: tripwire };
  return { ...actual, ...blocked, default: { ...actual.default, ...blocked } };
});
