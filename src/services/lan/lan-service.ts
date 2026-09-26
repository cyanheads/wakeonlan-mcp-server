/**
 * @fileoverview LAN operations behind the wake and check tools: segment
 * resolution against the live interface table, TCP reachability probes, and the
 * send-then-verify wake loop. Every OS boundary is an injected seam (see
 * `LanDeps`); production wiring uses `node:dgram`, `node:net`, `node:os`, and
 * `node:timers/promises`.
 * @module services/lan/lan-service
 */

import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HostProfile } from '@/services/hosts/types.js';
import { buildMagicPacket } from './magic-packet.js';
import { resolveSegment, type SegmentResolution } from './segment.js';
import type {
  LanDeps,
  ProbeOutcome,
  ProbeResult,
  ProbeSummary,
  SendStage,
  WakeResult,
} from './types.js';

/** Magic packets per wake. */
export const PACKET_COUNT = 3;
/** Gap between magic packets. */
export const PACKET_SPACING_MS = 500;
/** Per-probe connect timeout. */
export const PROBE_TIMEOUT_MS = 1500;
/** Gap between confirmation polls, measured from the first packet. */
export const POLL_INTERVAL_MS = 2000;

/** The segment fields a send needs. */
export type ResolvedSegment = Extract<SegmentResolution, { ok: true }>;

type SendFailure = Extract<WakeResult, { kind: 'send_failed' }>;

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * `ECONNREFUSED` → `refused`; everything else → `no_answer`. A hostname that
 * resolves to several addresses fails with an `AggregateError` whose own `code`
 * is copied from the first attempt only, so its `errors[]` are searched too.
 */
export function classifyConnectError(err: unknown): Exclude<ProbeOutcome, 'open'> {
  if (errorCode(err) === 'ECONNREFUSED') return 'refused';
  if (err instanceof AggregateError && err.errors.some((e) => errorCode(e) === 'ECONNREFUSED')) {
    return 'refused';
  }
  return 'no_answer';
}

export class LanService {
  /** Aliases with a wake in flight. */
  private readonly waking = new Set<string>();

  constructor(private readonly deps: LanDeps) {}

  get platform(): NodeJS.Platform {
    return this.deps.platform;
  }

  now(): number {
    return this.deps.clock.now();
  }

  /** Match a profile against the current interface table (interfaces change, so per call). */
  resolveSegment(profile: Pick<HostProfile, 'address' | 'broadcast'>): SegmentResolution {
    return resolveSegment(profile, this.deps.networkInterfaces());
  }

  /**
   * Open a TCP connection to `host:port` and close it without sending bytes.
   * Resolves `open`, `refused`, or `no_answer` (timeout or any other error);
   * rejects only when `signal` aborts.
   */
  async probe(
    host: string,
    port: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ProbeResult> {
    signal.throwIfAborted();
    const { clock } = this.deps;
    const startedAt = clock.now();
    const socket = this.deps.connectTcp({ host, port });

    const { promise: answered, resolve } = Promise.withResolvers<ProbeResult>();
    const settle = (outcome: ProbeOutcome) => {
      if (outcome === 'no_answer') return resolve({ outcome });
      const answeredAt = clock.now();
      resolve({ outcome, answeredAt, latencyMs: Math.round(answeredAt - startedAt) });
    };
    /** Stays attached after `destroy()` so a late socket error can never go unhandled. */
    const onError = (err: Error) => settle(classifyConnectError(err));
    const onConnect = () => settle('open');
    socket.once('error', onError);
    socket.once('connect', onConnect);

    const stopTimer = new AbortController();
    const timedOut = clock
      .sleep(timeoutMs, AbortSignal.any([signal, stopTimer.signal]))
      .then((): ProbeResult => ({ outcome: 'no_answer' }));
    try {
      return await Promise.race([answered, timedOut]);
    } finally {
      stopTimer.abort();
      socket.removeListener('connect', onConnect);
      socket.destroy();
    }
  }

  /**
   * Wake a host, one wake per host at a time: while another call is waking the
   * same profile this returns `in_progress` without sending or probing, since
   * concurrent wakes would multiply the broadcasts and check-port probes. The
   * host is claimed before the first await and freed however the wake ends.
   */
  async wake(
    profile: HostProfile,
    segment: ResolvedSegment,
    waitForS: number,
    signal: AbortSignal,
  ): Promise<WakeResult> {
    const { alias } = profile;
    if (this.waking.has(alias)) return { kind: 'in_progress' };
    this.waking.add(alias);
    try {
      return await this.sendAndConfirm(profile, segment, waitForS, signal);
    } finally {
      this.waking.delete(alias);
    }
  }

  /**
   * Send the magic packets, then confirm the wake. Probes `address:check_port`
   * before sending (to tell `already_awake` from a real wake) and every
   * `POLL_INTERVAL_MS` after the first packet until it answers or `waitForS`
   * elapses. Probing is skipped entirely without an address or when `waitForS`
   * is 0. A failed send is a `send_failed` result; cancellation rejects.
   */
  private async sendAndConfirm(
    profile: HostProfile,
    segment: ResolvedSegment,
    waitForS: number,
    signal: AbortSignal,
  ): Promise<WakeResult> {
    const packet = buildMagicPacket(profile.mac, profile.secureon);
    const { address, check_port: port } = profile;

    if (address === undefined || waitForS === 0) {
      const sent = await this.transmit(packet, segment, profile.wol_port, signal);
      if (sent.kind === 'send_failed') return sent;
      return {
        kind: 'sent',
        state: 'unverified',
        unverifiedReason: address === undefined ? 'no_address' : 'wait_disabled',
      };
    }

    const preProbe = await this.probe(address, port, PROBE_TIMEOUT_MS, signal);
    const sent = await this.transmit(packet, segment, profile.wol_port, signal);
    if (sent.kind === 'send_failed') return sent;

    const summary = (attempts: number, last: ProbeOutcome): ProbeSummary => ({
      address,
      port,
      attempts,
      last_outcome: last,
    });
    if (preProbe.outcome === 'open') {
      return { kind: 'sent', state: 'already_awake', probe: summary(1, 'open') };
    }

    const t0 = sent.firstSentAt;
    const deadline = t0 + waitForS * 1000;
    let attempts = 1;
    let last: ProbeOutcome = preProbe.outcome;
    for (
      let attemptAt = t0 + POLL_INTERVAL_MS;
      attemptAt < deadline;
      attemptAt += POLL_INTERVAL_MS
    ) {
      const wait = attemptAt - this.now();
      if (wait > 0) await this.deps.clock.sleep(wait, signal);
      const remaining = deadline - this.now();
      if (remaining <= 0) break;

      const result = await this.probe(address, port, Math.min(PROBE_TIMEOUT_MS, remaining), signal);
      attempts++;
      last = result.outcome;
      if (result.outcome === 'open') {
        return {
          kind: 'sent',
          state: 'awake',
          probe: summary(attempts, 'open'),
          timeToAnswerMs: Math.round(result.answeredAt - t0),
        };
      }
    }
    return { kind: 'sent', state: 'not_reachable', probe: summary(attempts, last) };
  }

  /**
   * One socket per call: bind to the matched interface address, enable
   * `SO_BROADCAST` once bound (it throws `EBADF` before), then send
   * `PACKET_COUNT` datagrams `PACKET_SPACING_MS` apart. The signal is checked
   * before the socket opens and before every send, so a cancelled call sends
   * nothing further. The socket always closes.
   */
  private async transmit(
    packet: Buffer,
    segment: ResolvedSegment,
    wolPort: number,
    signal: AbortSignal,
  ): Promise<SendFailure | { firstSentAt: number; kind: 'transmitted' }> {
    signal.throwIfAborted();
    const socket = this.deps.createUdpSocket({ type: 'udp4' });
    let stage: SendStage = 'bind';
    let packetsSent = 0;
    let firstSentAt = 0;
    /** An unhandled dgram 'error' event crashes the process; route it to the pending step. */
    let rejectPending: (err: Error) => void;
    const onError = (err: Error) => rejectPending(err);
    socket.once('error', onError);

    try {
      await new Promise<void>((resolve, reject) => {
        rejectPending = reject;
        socket.bind({ address: segment.localAddress, port: 0 }, () => {
          stage = 'set_broadcast';
          try {
            socket.setBroadcast(true);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });

      stage = 'send';
      for (let i = 0; i < PACKET_COUNT; i++) {
        if (i > 0) await this.deps.clock.sleep(PACKET_SPACING_MS, signal);
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          rejectPending = reject;
          socket.send(packet, wolPort, segment.broadcast, (err) => (err ? reject(err) : resolve()));
        });
        if (packetsSent === 0) firstSentAt = this.now();
        packetsSent++;
      }
      return { kind: 'transmitted', firstSentAt };
    } catch (err) {
      if (signal.aborted) throw err;
      const code = errorCode(err);
      return { kind: 'send_failed', stage, packetsSent, ...(code !== undefined && { code }) };
    } finally {
      socket.removeListener('error', onError);
      socket.close();
    }
  }
}

const productionDeps: LanDeps = {
  createUdpSocket: (options) => createSocket(options),
  connectTcp: (options) => connect(options),
  networkInterfaces: () => networkInterfaces(),
  clock: {
    now: () => performance.now(),
    sleep: (ms, signal) => sleep(ms, undefined, signal ? { signal } : {}),
  },
  platform: process.platform,
};

let _service: LanService | undefined;

/** Initialize with production seams; tests pass fakes for any of them. */
export function initLanService(deps?: Partial<LanDeps>): void {
  _service = new LanService({ ...productionDeps, ...deps });
}

export function getLanService(): LanService {
  if (!_service) {
    throw new Error('LanService not initialized — call initLanService() in setup()');
  }
  return _service;
}
