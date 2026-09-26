/**
 * @fileoverview LAN service seams and result types. Every OS boundary — UDP,
 * TCP, the interface table, the clock, and the platform — is an injected
 * dependency so the test suite never opens a real socket.
 * @module services/lan/types
 */

import type { Socket as UdpSocket } from 'node:dgram';
import type { Socket as TcpSocket } from 'node:net';
import type { InterfaceTable } from './segment.js';

/** The slice of `dgram.Socket` the sender uses. */
export type UdpSocketLike = Pick<
  UdpSocket,
  'bind' | 'setBroadcast' | 'send' | 'close' | 'once' | 'removeListener'
>;

/** The slice of `net.Socket` the probe uses. */
export type TcpSocketLike = Pick<TcpSocket, 'once' | 'removeListener' | 'destroy'>;

/** Monotonic time and cancellable waits; every timing in the LAN path goes through it. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface LanDeps {
  clock: Clock;
  connectTcp(options: { host: string; port: number }): TcpSocketLike;
  createUdpSocket(options: { type: 'udp4' }): UdpSocketLike;
  networkInterfaces(): InterfaceTable;
  /** Read by the macOS Local Network guidance and recovery text. */
  platform: NodeJS.Platform;
}

/** `open` is the only reachable outcome; `refused` means the machine answered but nothing listens. */
export type ProbeOutcome = 'open' | 'refused' | 'no_answer';

export type ProbeResult =
  | {
      /** Clock time the connection answered. */
      answeredAt: number;
      /** Connect start → answer. */
      latencyMs: number;
      outcome: 'open' | 'refused';
    }
  | { outcome: 'no_answer' };

/** Where a UDP send failed. */
export type SendStage = 'bind' | 'set_broadcast' | 'send';

export type WakeState = 'already_awake' | 'awake' | 'not_reachable' | 'unverified';

export interface ProbeSummary {
  address: string;
  attempts: number;
  last_outcome: ProbeOutcome;
  port: number;
}

export type WakeResult =
  /** Another wake of the same host is still running; nothing was sent. */
  | { kind: 'in_progress' }
  | {
      code?: string;
      kind: 'send_failed';
      packetsSent: number;
      stage: SendStage;
    }
  | {
      kind: 'sent';
      probe?: ProbeSummary;
      state: WakeState;
      /** First packet sent → probe connected; `awake` only. */
      timeToAnswerMs?: number;
      unverifiedReason?: 'wait_disabled' | 'no_address';
    };
