import crypto from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { ServerMessage } from '../shared/types.js';

export interface Actor {
  userId: string;
  username: string;
  isGm: boolean;
}

export const SYSTEM_ACTOR: Actor = { userId: 'system', username: 'system', isGm: false };

/** Receives change notifications after a transaction commits. Implemented by the WebSocket hub. */
export interface EventSink {
  /** Inventory/donation state of these roles changed; `gm` = GM views should refresh. */
  changed(roles: string[], opts: { gm: boolean; catalog?: boolean }): void;
  notifyRole(roleId: string, message: ServerMessage): void;
  /** A user's own session data (e.g. role assignment) changed. */
  userChanged(userId: string): void;
  /** A user's sessions were revoked (disabled, deleted, password reset). */
  userRevoked(userId: string): void;
}

export const nullSink: EventSink = {
  changed() {},
  notifyRole() {},
  userChanged() {},
  userRevoked() {},
};

type Pending = (sink: EventSink) => void;

export class Ctx {
  private queue: Pending[] | null = null;

  constructor(
    readonly db: Db,
    readonly clock: Clock,
    readonly config: Config,
    public sink: EventSink = nullSink,
  ) {}

  now(): number {
    return this.clock.now();
  }

  /**
   * Runs `fn` in a database transaction. Events queued with `emit` are delivered only
   * if the transaction commits, so clients never hear about changes that rolled back.
   */
  tx<T>(fn: () => T): T {
    if (this.queue) return this.db.tx(fn); // nested: share outer queue
    this.queue = [];
    let events: Pending[] = [];
    try {
      const result = this.db.tx(fn);
      events = this.queue;
      return result;
    } finally {
      this.queue = null;
      for (const e of events) {
        try {
          e(this.sink);
        } catch (err) {
          console.error('Event delivery failed', err);
        }
      }
    }
  }

  emit(fn: Pending): void {
    if (this.queue) this.queue.push(fn);
    else fn(this.sink);
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Human-friendly transaction id, e.g. DN-7F3A9C21B04E. */
export function newDonationId(): string {
  return 'DN-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}
