/**
 * @fileoverview Fakes for every OS boundary `LanService` takes as a seam: a
 * virtual clock, a scripted TCP connector, a recording UDP socket, and the
 * interface table. Nothing here touches the network or reads host state.
 * @module tests/helpers/lan-fakes
 */

import { initLanService } from '@/services/lan/lan-service.js';
import type { InterfaceTable } from '@/services/lan/segment.js';
import type { Clock, LanDeps, TcpSocketLike, UdpSocketLike } from '@/services/lan/types.js';
import { LAN_TABLE } from './fixtures.js';

type Listener = (...args: unknown[]) => void;

interface Timer {
  at: number;
  fire: () => void;
  seq: number;
}

/** Node's `timers/promises` rejects an aborted sleep with this shape. */
function abortError(signal: AbortSignal | undefined): Error {
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
    cause: signal?.reason,
  });
}

/** An `Error` carrying a Node-style errno `code`. */
export function coded(code: string, message = `${code} (fake)`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Virtual clock. Every sleep and scheduled event is a timer; time moves only
 * when the earliest timer fires, and it fires on a later macrotask so every
 * promise continuation settles first. A probe's timeout sleep and its socket's
 * answer therefore race on virtual time, and `now()` never runs ahead of the
 * event that resolved — a 55 s wait finishes in milliseconds.
 */
export class VirtualClock implements Clock {
  /** Every `sleep()` requested, in call order: when it began and how long it asked for. */
  readonly sleeps: Array<{ at: number; ms: number }> = [];
  #current: number;
  #pumpQueued = false;
  #seq = 0;
  readonly #timers: Timer[] = [];

  constructor(start = 50_000) {
    this.#current = start;
  }

  now(): number {
    return this.#current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push({ at: this.#current, ms });
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const onAbort = () => {
        this.#cancel(timer);
        reject(abortError(signal));
      };
      const timer = this.schedule(ms, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Run `fire` when virtual time reaches `now() + ms`. */
  schedule(ms: number, fire: () => void): Timer {
    const timer = { at: this.#current + ms, seq: this.#seq++, fire };
    this.#timers.push(timer);
    this.#queuePump();
    return timer;
  }

  /** Timers still waiting to fire. */
  get pending(): number {
    return this.#timers.length;
  }

  #cancel(timer: Timer): void {
    const index = this.#timers.indexOf(timer);
    if (index !== -1) this.#timers.splice(index, 1);
  }

  #queuePump(): void {
    if (this.#pumpQueued) return;
    this.#pumpQueued = true;
    setImmediate(() => {
      this.#pumpQueued = false;
      this.#fireNext();
    });
  }

  #fireNext(): void {
    this.#timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = this.#timers.shift();
    if (!next) return;
    this.#current = next.at;
    next.fire();
    if (this.#timers.length > 0) this.#queuePump();
  }
}

/** One scripted TCP connect attempt. */
export type TcpBehavior =
  | 'open'
  | 'refused'
  | 'unreachable'
  | 'silent'
  | { afterMs: number; kind: 'open' | 'refused' }
  | { afterMs?: number; error: unknown; kind: 'error' };

/** Virtual latency of each scripted answer. */
export const LATENCY = { open: 4, refused: 2, unreachable: 3 } as const;

type ResolvedBehavior =
  | { afterMs: number; kind: 'open' }
  | { afterMs: number; error: unknown; kind: 'error' }
  | { kind: 'silent' };

function resolveBehavior(behavior: TcpBehavior, host: string, port: number): ResolvedBehavior {
  const refused = () => coded('ECONNREFUSED', `connect ECONNREFUSED ${host}:${port}`);
  switch (behavior) {
    case 'open':
      return { kind: 'open', afterMs: LATENCY.open };
    case 'refused':
      return { kind: 'error', afterMs: LATENCY.refused, error: refused() };
    case 'unreachable':
      return {
        kind: 'error',
        afterMs: LATENCY.unreachable,
        error: coded('EHOSTUNREACH', `connect EHOSTUNREACH ${host}:${port}`),
      };
    case 'silent':
      return { kind: 'silent' };
    default:
      if (behavior.kind === 'error') {
        return { kind: 'error', afterMs: behavior.afterMs ?? 0, error: behavior.error };
      }
      return behavior.kind === 'open'
        ? { kind: 'open', afterMs: behavior.afterMs }
        : { kind: 'error', afterMs: behavior.afterMs, error: refused() };
  }
}

/**
 * A `net.Socket` stand-in. Emits nothing after `destroy()`, and — like Node —
 * throws when an `'error'` is emitted with no listener attached.
 */
export class FakeTcpSocket {
  /** Listener registrations and destroy calls, in order. */
  readonly log: string[] = [];
  #destroyed = false;
  readonly #listeners = new Map<string, Listener[]>();

  get destroyed(): boolean {
    return this.#destroyed;
  }

  get destroyCount(): number {
    return this.log.filter((entry) => entry === 'destroy').length;
  }

  once(event: string, listener: Listener): this {
    this.log.push(`once:${event}`);
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.log.push(`remove:${event}`);
    this.#listeners.set(
      event,
      (this.#listeners.get(event) ?? []).filter((l) => l !== listener),
    );
    return this;
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const listeners = this.#listeners.get(event) ?? [];
    if (listeners.length === 0) {
      if (event === 'error') throw args[0];
      return false;
    }
    this.#listeners.set(event, []);
    for (const listener of listeners) listener(...args);
    return true;
  }

  destroy(): this {
    this.log.push('destroy');
    this.#destroyed = true;
    return this;
  }
}

/** One recorded `connectTcp()` call. */
export interface TcpConnect {
  at: number;
  host: string;
  port: number;
  socket: FakeTcpSocket;
}

/**
 * Scripted TCP connector. Each host has a queue of behaviors consumed one per
 * connect; the last entry repeats once the queue runs out, and unscripted hosts
 * use `fallback`.
 */
export class FakeTcp {
  readonly connects: TcpConnect[] = [];

  constructor(
    private readonly clock: VirtualClock,
    private readonly script: Readonly<Record<string, readonly TcpBehavior[]>>,
    private readonly fallback: TcpBehavior,
  ) {}

  readonly connectTcp = (options: { host: string; port: number }): TcpSocketLike => {
    const socket = new FakeTcpSocket();
    const attempt = this.connects.filter((c) => c.host === options.host).length;
    this.connects.push({ host: options.host, port: options.port, at: this.clock.now(), socket });

    const queue = this.script[options.host] ?? [];
    const scripted = queue[Math.min(attempt, queue.length - 1)] ?? this.fallback;
    const behavior = resolveBehavior(scripted, options.host, options.port);
    if (behavior.kind !== 'silent') {
      this.clock.schedule(behavior.afterMs, () => {
        if (socket.destroyed) return;
        if (behavior.kind === 'open') socket.emit('connect');
        else socket.emit('error', behavior.error);
      });
    }
    return socket as unknown as TcpSocketLike;
  };
}

/** One recorded call on a fake UDP socket. */
export type UdpCall =
  | { event: string; op: 'once' | 'removeListener' }
  | { address: string; op: 'bind'; port: number }
  | { flag: boolean; op: 'setBroadcast' }
  | { address: string; at: number; bytes: Buffer; op: 'send'; port: number }
  | { op: 'close' };

/** How a fake UDP socket fails, if at all. */
export interface UdpScript {
  /** Emit this as an `'error'` event instead of completing the bind. */
  bindError?: Error;
  /** Emit this as an `'error'` event during the Nth send (1-based) instead of calling its callback. */
  errorEventOnSend?: { error: Error; nth: number };
  /** Fail the Nth send (1-based) through its callback. */
  failSend?: { error: Error; nth: number };
  /** Throw this from `setBroadcast()` once bound. */
  setBroadcastError?: Error;
}

/**
 * A `dgram.Socket` stand-in that records every call in order. Like Node, its
 * bind completes asynchronously, `setBroadcast()` throws `EBADF` until it has,
 * and an `'error'` emitted with no listener throws.
 */
export class FakeUdpSocket {
  readonly calls: UdpCall[] = [];
  #bound = false;
  #closed = false;
  #errorListeners: Listener[] = [];
  #sends = 0;

  constructor(
    private readonly clock: VirtualClock,
    private readonly script: UdpScript,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  /** The operation names in call order, e.g. `['once', 'bind', 'setBroadcast', …]`. */
  get ops(): string[] {
    return this.calls.map((call) => call.op);
  }

  get sends(): Array<Extract<UdpCall, { op: 'send' }>> {
    return this.calls.filter(
      (call): call is Extract<UdpCall, { op: 'send' }> => call.op === 'send',
    );
  }

  once(event: string, listener: Listener): this {
    this.calls.push({ op: 'once', event });
    if (event === 'error') this.#errorListeners.push(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.calls.push({ op: 'removeListener', event });
    this.#errorListeners = this.#errorListeners.filter((l) => l !== listener);
    return this;
  }

  bind(options: { address: string; port: number }, callback: () => void): this {
    this.calls.push({ op: 'bind', address: options.address, port: options.port });
    queueMicrotask(() => {
      if (this.script.bindError) {
        this.#emitError(this.script.bindError);
        return;
      }
      this.#bound = true;
      callback();
    });
    return this;
  }

  setBroadcast(flag: boolean): void {
    this.calls.push({ op: 'setBroadcast', flag });
    if (!this.#bound) throw coded('EBADF', 'setBroadcast EBADF');
    if (this.script.setBroadcastError) throw this.script.setBroadcastError;
  }

  send(msg: Buffer, port: number, address: string, callback: (error: Error | null) => void): void {
    if (this.#closed) throw coded('ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
    this.#sends++;
    const nth = this.#sends;
    this.calls.push({ op: 'send', bytes: Buffer.from(msg), port, address, at: this.clock.now() });
    queueMicrotask(() => {
      const { errorEventOnSend, failSend } = this.script;
      if (errorEventOnSend?.nth === nth) {
        this.#emitError(errorEventOnSend.error);
        return;
      }
      callback(failSend?.nth === nth ? failSend.error : null);
    });
  }

  close(): void {
    this.calls.push({ op: 'close' });
    this.#closed = true;
  }

  #emitError(error: Error): void {
    const listeners = this.#errorListeners;
    this.#errorListeners = [];
    if (listeners.length === 0) throw error;
    for (const listener of listeners) listener(error);
  }
}

/** Records every socket `createUdpSocket()` handed out. */
export class FakeUdp {
  readonly requestedTypes: string[] = [];
  readonly sockets: FakeUdpSocket[] = [];

  constructor(
    private readonly clock: VirtualClock,
    private readonly script: UdpScript,
  ) {}

  /** The one socket a wake opened; fails the test when there were none or several. */
  get only(): FakeUdpSocket {
    if (this.sockets.length !== 1) {
      throw new Error(`Expected exactly one UDP socket, got ${this.sockets.length}`);
    }
    return this.sockets[0] as FakeUdpSocket;
  }

  readonly createUdpSocket = (options: { type: 'udp4' }): UdpSocketLike => {
    this.requestedTypes.push(options.type);
    const socket = new FakeUdpSocket(this.clock, this.script);
    this.sockets.push(socket);
    return socket as unknown as UdpSocketLike;
  };
}

export interface LanFakeOptions {
  /** Defaults to {@link LAN_TABLE}. */
  interfaces?: InterfaceTable;
  platform?: NodeJS.Platform;
  /** Virtual clock start. */
  start?: number;
  /** Per-host connect behaviors, consumed in order; the last repeats. */
  tcp?: Readonly<Record<string, readonly TcpBehavior[]>>;
  /** Behavior for hosts with no script. Defaults to `silent`. */
  tcpFallback?: TcpBehavior;
  udp?: UdpScript;
}

export interface LanFakes {
  clock: VirtualClock;
  deps: LanDeps;
  /** How many times the interface table was read. */
  readonly interfaceReads: number;
  /** Replace the interface table the next read returns. */
  setInterfaces(table: InterfaceTable): void;
  tcp: FakeTcp;
  udp: FakeUdp;
}

/** Build a full set of `LanDeps` fakes. */
export function createLanFakes(options: LanFakeOptions = {}): LanFakes {
  const clock = new VirtualClock(options.start);
  const tcp = new FakeTcp(clock, options.tcp ?? {}, options.tcpFallback ?? 'silent');
  const udp = new FakeUdp(clock, options.udp ?? {});
  let table: InterfaceTable = options.interfaces ?? LAN_TABLE;
  let reads = 0;
  return {
    clock,
    tcp,
    udp,
    get interfaceReads() {
      return reads;
    },
    setInterfaces(next) {
      table = next;
    },
    deps: {
      clock,
      connectTcp: tcp.connectTcp,
      createUdpSocket: udp.createUdpSocket,
      networkInterfaces: () => {
        reads++;
        return table;
      },
      platform: options.platform ?? 'linux',
    },
  };
}

/** Initialize the `LanService` singleton on fresh fakes and return them. */
export function installLanFakes(options: LanFakeOptions = {}): LanFakes {
  const fakes = createLanFakes(options);
  initLanService(fakes.deps);
  return fakes;
}
