/**
 * MODEL CODE, used by tests only. This is NOT EventBridge and it is not an emulator.
 *
 * It models the documented semantics of the enhanced EventBridge custom event bus
 * (the `eventsv2` API) closely enough to test this repo's publisher and subscribers
 * without an AWS account:
 *
 * - Deduplication at publish time: by DeduplicationId, or by content when the request
 *   sets DeduplicationType=CONTENT_BASED. Window of 300 seconds, scoped to the
 *   publishing account and to the event group (ungrouped entries share one scope).
 *   A suppressed duplicate returns SuccessCode DEDUPLICATED.
 * - Retention of every accepted event for 1 to 365 days.
 * - Subscribers with Type FIFO (in order within an event group; a failing event holds
 *   up later events of its own group only) or UNORDERED (any order).
 * - StartingPosition LATEST or POINT_IN_TIME (HORIZON, or TIMESTAMP with an optional
 *   end point). Events read from history carry aws:DeliveryType REPLAY.
 * - RetryPolicy (MaxRetryAttempts, MaxEventAgeInSeconds) and a dead-letter record.
 * - Filters by scope (DATA, SYSTEM_METADATA) with AND between them.
 *
 * Where the docs leave a detail open, this model picks one and says so in a comment
 * marked ASSUMPTION. Tests built on the model prove our code against these semantics,
 * not against the service. Run scripts/smoke-test.ts against a real bus for that.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PutEventsRequestEntry, PutEventsResultEntry } from '@aws-sdk/client-eventbridgev2';
import { matchesPattern } from './pattern';

export const DEDUP_WINDOW_MS = 300_000;
const DAY_MS = 86_400_000;

export interface DeliveredEvent {
  Data: Record<string, unknown>;
  Metadata: Record<string, string>;
  SystemMetadata: Record<string, string>;
}

interface StoredEvent {
  seq: number;
  eventId: string;
  account: string;
  groupId?: string;
  dedupId?: string;
  ingestionTime: number;
  data: Record<string, unknown>;
}

export type StartingPosition =
  | { type: 'LATEST' }
  | { type: 'POINT_IN_TIME'; pointType: 'HORIZON'; endPoint?: number }
  | { type: 'POINT_IN_TIME'; pointType: 'TIMESTAMP'; startingPoint: number; endPoint?: number };

export interface SubscriberSpec {
  name: string;
  type: 'FIFO' | 'UNORDERED';
  filters?: { scope: 'DATA' | 'SYSTEM_METADATA'; pattern: string }[];
  startingPosition?: StartingPosition;
  retry?: { maxRetryAttempts?: number; maxEventAgeSeconds?: number };
  maxBatchSize?: number;
  /** Optional dead-letter queue. Without one, exhausted events are dropped and counted. */
  deadLetter?: DeadLetterRecord[];
  /** The target. Throwing means the delivery failed. */
  target: (batch: DeliveredEvent[]) => Promise<void>;
}

export interface DeadLetterRecord {
  subscriber: string;
  errorCode: string;
  errorMessage: string;
  exhaustedRetryCondition: 'MaximumRetryAttempts' | 'MaximumEventAgeInSeconds';
  retryAttempts: number;
  failedMessages: { eventId: string; eventGroupId: string | null; deduplicationId: string | null; timestamp: string }[];
}

interface Pending {
  event: StoredEvent;
  attempts: number;
  deliveryType: 'LIVE' | 'REPLAY';
}

class ModelSubscriber {
  readonly createdAt: number;
  state: 'RUNNING' | 'STOPPED' = 'RUNNING';
  lastSeenSeq: number;
  endPoint?: number;
  startTime?: number;
  pending: Pending[] = [];
  dropped = 0;
  deliveredCount = 0;

  constructor(
    readonly spec: SubscriberSpec,
    createdAt: number,
    lastSeq: number,
  ) {
    this.createdAt = createdAt;
    const pos = spec.startingPosition ?? { type: 'LATEST' };
    if (pos.type === 'LATEST') {
      this.lastSeenSeq = lastSeq;
    } else {
      this.lastSeenSeq = 0;
      this.startTime = pos.pointType === 'TIMESTAMP' ? pos.startingPoint : Number.NEGATIVE_INFINITY;
      this.endPoint = pos.endPoint;
    }
  }
}

export class BusModel {
  private now: number;
  private seq = 0;
  private log: StoredEvent[] = [];
  private dedup = new Map<string, number>();
  private subscribers = new Map<string, ModelSubscriber>();
  private failures: { match: (e: PutEventsRequestEntry) => boolean; remaining: number; code: string }[] = [];
  private rng: () => number;
  readonly createdAt: number;

  constructor(
    readonly options: { retentionDays?: number; startTime?: number; seed?: number; region?: string } = {},
  ) {
    const days = options.retentionDays ?? 1;
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('RetentionPeriodInDays must be 1 to 365');
    this.now = options.startTime ?? Date.UTC(2026, 9, 1);
    this.createdAt = this.now;
    // Small deterministic PRNG so UNORDERED delivery is shuffled the same way on every run.
    let s = options.seed ?? 42;
    this.rng = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  get retentionDays(): number {
    return this.options.retentionDays ?? 1;
  }

  clock(): number {
    return this.now;
  }

  advance(ms: number): void {
    this.now += ms;
    this.prune();
  }

  /** The earliest point a subscriber can start from: creation time, or now minus retention. */
  retentionWindowStart(): number {
    return Math.max(this.createdAt, this.now - this.retentionDays * DAY_MS);
  }

  /** Makes the next `times` entries that match fail with the given ErrorCode. */
  injectPublishFailure(match: (e: PutEventsRequestEntry) => boolean, times = 1, code = 'InternalFailure'): void {
    this.failures.push({ match, remaining: times, code });
  }

  storedEvents(): readonly { eventId: string; groupId?: string; detail: unknown; ingestionTime: number }[] {
    return this.log.map((e) => ({ eventId: e.eventId, groupId: e.groupId, detail: e.data.detail, ingestionTime: e.ingestionTime }));
  }

  putEvents(
    account: string,
    entries: PutEventsRequestEntry[],
    deduplication?: { DeduplicationType?: string },
  ): PutEventsResultEntry[] {
    if (entries.length < 1 || entries.length > 100) throw new Error('PutEvents takes 1 to 100 entries');
    const contentBased = deduplication?.DeduplicationType === 'CONTENT_BASED';
    return entries.map((entry) => {
      const failure = this.failures.find((f) => f.remaining > 0 && f.match(entry));
      if (failure) {
        failure.remaining -= 1;
        return { ErrorCode: failure.code, ErrorMessage: 'injected by the model' };
      }
      if (!entry.Source || !entry.DetailType) return { ErrorCode: 'ValidationException', ErrorMessage: 'Source and DetailType are required' };
      if (entry.Source.startsWith('aws.')) return { ErrorCode: 'ValidationException', ErrorMessage: 'aws. sources are reserved' };
      let detail: unknown;
      try {
        detail = entry.Detail === undefined ? {} : (JSON.parse(entry.Detail) as unknown);
      } catch {
        return { ErrorCode: 'ValidationException', ErrorMessage: 'Detail must be valid JSON' };
      }
      const groupId = entry.SystemMetadata?.EventGroupId;
      const dedupId = entry.SystemMetadata?.DeduplicationId;

      // ASSUMPTION: the content hash covers Source, DetailType, Detail and Resources.
      // The docs say EventBridge "hashes the content of each entry" without listing fields.
      const key = contentBased
        ? createHash('sha256').update(JSON.stringify([entry.Source, entry.DetailType, entry.Detail, entry.Resources ?? []])).digest('hex')
        : dedupId;
      if (key !== undefined) {
        const scope = `${account}\u0000${groupId === undefined ? 'ungrouped' : `group:${groupId}`}\u0000${key}`;
        const acceptedAt = this.dedup.get(scope);
        // ASSUMPTION: a duplicate exactly 300 s later is still inside the window.
        if (acceptedAt !== undefined && this.now - acceptedAt <= DEDUP_WINDOW_MS) {
          return { SuccessCode: 'DEDUPLICATED' };
        }
        this.dedup.set(scope, this.now);
      }

      this.seq += 1;
      const eventId = randomUUID();
      this.log.push({
        seq: this.seq,
        eventId,
        account,
        groupId,
        dedupId,
        ingestionTime: this.now,
        data: {
          version: '0',
          id: eventId,
          'detail-type': entry.DetailType,
          source: entry.Source,
          account,
          time: (entry.Time ?? new Date(this.now)).toISOString(),
          region: this.options.region ?? 'us-east-1',
          resources: entry.Resources ?? [],
          detail,
        },
      });
      return { SuccessCode: 'PUBLISHED', EventId: eventId, SequenceNumber: String(this.seq) };
    });
  }

  createSubscriber(spec: SubscriberSpec): void {
    if (this.subscribers.has(spec.name)) throw new Error(`subscriber ${spec.name} already exists`);
    const pos = spec.startingPosition;
    if (pos?.type === 'POINT_IN_TIME' && pos.pointType === 'TIMESTAMP') {
      if (pos.startingPoint < this.retentionWindowStart() || pos.startingPoint > this.now) {
        throw new Error('StartingPoint must be inside the retention window and not in the future');
      }
    }
    const filters = spec.filters ?? [];
    const scopes = filters.map((f) => f.scope);
    if (new Set(scopes).size !== scopes.length) throw new Error('at most one filter per scope');
    this.subscribers.set(spec.name, new ModelSubscriber(spec, this.now, this.seq));
  }

  stopSubscriber(name: string): void {
    this.sub(name).state = 'STOPPED';
  }

  resumeSubscriber(name: string, position: 'LAST_PROCESSED' | 'LATEST' = 'LAST_PROCESSED'): void {
    const sub = this.sub(name);
    if (sub.state !== 'STOPPED') throw new Error('ResumePosition applies only to a STOPPED to RUNNING change');
    if (position === 'LATEST') {
      if (sub.spec.startingPosition?.type === 'POINT_IN_TIME') throw new Error('a replaying subscriber cannot resume at LATEST');
      sub.pending = [];
      sub.lastSeenSeq = this.seq;
    }
    sub.state = 'RUNNING';
  }

  stats(name: string): { pending: number; dropped: number; delivered: number } {
    const sub = this.sub(name);
    return { pending: sub.pending.length, dropped: sub.dropped, delivered: sub.deliveredCount };
  }

  /**
   * Runs one delivery round for every running subscriber. Each round makes at most
   * one attempt per FIFO group, or one attempt per UNORDERED batch.
   */
  async pump(): Promise<void> {
    for (const sub of this.subscribers.values()) {
      if (sub.state !== 'RUNNING') continue;
      this.collect(sub);
      if (sub.spec.type === 'FIFO') await this.deliverFifo(sub);
      else await this.deliverUnordered(sub);
    }
  }

  /** Pumps until nothing is pending, advancing the clock between rounds like a retry backoff. */
  async drain(stepMs = 1_000, maxRounds = 10_000): Promise<void> {
    for (let i = 0; i < maxRounds; i += 1) {
      await this.pump();
      const busy = [...this.subscribers.values()].some((s) => s.state === 'RUNNING' && (s.pending.length > 0 || s.lastSeenSeq < this.seq));
      if (!busy) return;
      this.advance(stepMs);
    }
    throw new Error('drain did not settle');
  }

  private sub(name: string): ModelSubscriber {
    const sub = this.subscribers.get(name);
    if (!sub) throw new Error(`no subscriber ${name}`);
    return sub;
  }

  private prune(): void {
    const cutoff = this.now - this.retentionDays * DAY_MS;
    this.log = this.log.filter((e) => e.ingestionTime >= cutoff);
    for (const [k, t] of this.dedup) if (this.now - t > DEDUP_WINDOW_MS) this.dedup.delete(k);
  }

  private delivered(event: StoredEvent, deliveryType: 'LIVE' | 'REPLAY'): DeliveredEvent {
    const sys: Record<string, string> = {
      ContentType: 'application/eventbridge+json',
      'aws:EventId': event.eventId,
      'aws:IngestionTime': new Date(event.ingestionTime).toISOString(),
      'aws:SequenceNumber': String(event.seq),
      'aws:DeliveryType': deliveryType,
      'aws:Source': String(event.data.source),
      'aws:DetailType': String(event.data['detail-type']),
    };
    // Optional fields are omitted when they have no value.
    if (event.groupId !== undefined) sys.EventGroupId = event.groupId;
    if (event.dedupId !== undefined) sys.DeduplicationId = event.dedupId;
    return { Data: event.data, Metadata: {}, SystemMetadata: sys };
  }

  private matches(sub: ModelSubscriber, d: DeliveredEvent): boolean {
    return (sub.spec.filters ?? []).every((f) =>
      matchesPattern(f.pattern, f.scope === 'DATA' ? d.Data : d.SystemMetadata),
    );
  }

  /** Moves newly visible events from the log into the subscriber's pending list. */
  private collect(sub: ModelSubscriber): void {
    for (const event of this.log) {
      if (event.seq <= sub.lastSeenSeq) continue;
      sub.lastSeenSeq = event.seq;
      if (sub.startTime !== undefined && event.ingestionTime < sub.startTime) continue;
      if (sub.endPoint !== undefined && event.ingestionTime > sub.endPoint) continue;
      // An event published before the subscriber existed is read from retained history.
      const deliveryType = event.ingestionTime < sub.createdAt ? 'REPLAY' : 'LIVE';
      if (!this.matches(sub, this.delivered(event, deliveryType))) continue;
      sub.pending.push({ event, attempts: 0, deliveryType });
    }
  }

  private async attempt(sub: ModelSubscriber, batch: Pending[]): Promise<void> {
    try {
      await sub.spec.target(batch.map((p) => this.delivered(p.event, p.deliveryType)));
      sub.pending = sub.pending.filter((p) => !batch.includes(p));
      sub.deliveredCount += batch.length;
    } catch (err) {
      const maxRetries = sub.spec.retry?.maxRetryAttempts ?? 5;
      const maxAgeMs = (sub.spec.retry?.maxEventAgeSeconds ?? 300) * 1000;
      const exhausted: Pending[] = [];
      let condition: DeadLetterRecord['exhaustedRetryCondition'] = 'MaximumRetryAttempts';
      for (const p of batch) {
        p.attempts += 1;
        // ASSUMPTION: one first attempt plus MaxRetryAttempts retries.
        const tooOld = this.now - p.event.ingestionTime >= maxAgeMs;
        if (p.attempts > maxRetries || tooOld) {
          if (tooOld) condition = 'MaximumEventAgeInSeconds';
          exhausted.push(p);
        }
      }
      if (exhausted.length === 0) return;
      sub.pending = sub.pending.filter((p) => !exhausted.includes(p));
      if (!sub.spec.deadLetter) {
        sub.dropped += exhausted.length;
        return;
      }
      sub.spec.deadLetter.push({
        subscriber: sub.spec.name,
        errorCode: (err as { code?: string }).code ?? 'COMPUTE_EXECUTION_ERROR',
        errorMessage: String((err as Error).message ?? err).slice(0, 1024),
        exhaustedRetryCondition: condition,
        retryAttempts: Math.max(...exhausted.map((p) => p.attempts)) - 1,
        failedMessages: exhausted.map((p) => ({
          eventId: p.event.eventId,
          eventGroupId: p.event.groupId ?? null,
          deduplicationId: p.event.dedupId ?? null,
          timestamp: new Date(p.event.ingestionTime).toISOString(),
        })),
      });
    }
  }

  /**
   * FIFO: each group's events go out in sequence order, and a group waits while its head
   * is failing. Other groups keep going.
   * ASSUMPTION: the model batches within one group. The docs say a real FIFO batch can mix
   * groups, keeping each group's events in order; that doesn't change what a target sees
   * per group. Events without an EventGroupId are treated as one-event groups.
   */
  private async deliverFifo(sub: ModelSubscriber): Promise<void> {
    const max = sub.spec.maxBatchSize ?? 10;
    const groups = new Map<string, Pending[]>();
    for (const p of sub.pending) {
      const key = p.event.groupId === undefined ? `ungrouped:${p.event.seq}` : `group:${p.event.groupId}`;
      const list = groups.get(key) ?? [];
      list.push(p);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      await this.attempt(sub, list.slice(0, max));
    }
  }

  /** UNORDERED: batches drawn in a shuffled order; a failure holds up nothing else. */
  private async deliverUnordered(sub: ModelSubscriber): Promise<void> {
    const max = sub.spec.maxBatchSize ?? 10;
    const shuffled = [...sub.pending];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as Pending, shuffled[i] as Pending];
    }
    for (let i = 0; i < shuffled.length; i += max) {
      await this.attempt(sub, shuffled.slice(i, i + max));
    }
  }
}
