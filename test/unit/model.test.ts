/**
 * Tests for the bus MODEL itself. Each test names the documented behaviour it models,
 * so a reader can check the model against the EventBridge docs.
 */
import type { PutEventsRequestEntry } from '@aws-sdk/client-eventbridgev2';
import { toPutEventsEntry } from '../../src/contract/order-events';
import { BusModel, type DeadLetterRecord, type DeliveredEvent } from '../../src/model/bus-model';
import { orderEvent } from '../support/fixtures';

const ACCOUNT = '123456789012';
const OTHER_ACCOUNT = 'second-account';
/** The documented window: "within 5 minutes (300 seconds)". Written out, not imported, so a change to the model's constant fails a test. */
const DEDUP_WINDOW_MS = 300_000;

const entry = (orderId: string, version: number, dedupId?: string): PutEventsRequestEntry => {
  const e = toPutEventsEntry(orderEvent(orderId, version));
  return { ...e, SystemMetadata: { ...e.SystemMetadata, DeduplicationId: dedupId ?? e.SystemMetadata?.DeduplicationId } };
};
const versions = (batches: DeliveredEvent[][]) =>
  batches.flat().map((d) => `${(d.Data.detail as { orderId: string }).orderId}:v${(d.Data.detail as { version: number }).version}`);

describe('deduplication at publish time', () => {
  test('a repeat DeduplicationId within 300 s returns DEDUPLICATED and stores nothing', () => {
    const bus = new BusModel();
    expect(bus.putEvents(ACCOUNT, [entry('a', 1, 'k1')])[0]?.SuccessCode).toBe('PUBLISHED');
    bus.advance(DEDUP_WINDOW_MS);
    expect(bus.putEvents(ACCOUNT, [entry('a', 1, 'k1')])[0]?.SuccessCode).toBe('DEDUPLICATED');
    expect(bus.storedEvents()).toHaveLength(1);
  });

  test('after the window, the same key is a new event', () => {
    const bus = new BusModel();
    bus.putEvents(ACCOUNT, [entry('a', 1, 'k1')]);
    bus.advance(DEDUP_WINDOW_MS + 1);
    expect(bus.putEvents(ACCOUNT, [entry('a', 1, 'k1')])[0]?.SuccessCode).toBe('PUBLISHED');
    expect(bus.storedEvents()).toHaveLength(2);
  });

  test('the check is scoped to the event group: same key in another group is a different event', () => {
    const bus = new BusModel();
    const results = bus.putEvents(ACCOUNT, [entry('a', 1, 'k1'), entry('b', 1, 'k1')]);
    expect(results.map((r) => r.SuccessCode)).toEqual(['PUBLISHED', 'PUBLISHED']);
  });

  test('the check is scoped to the account', () => {
    const bus = new BusModel();
    bus.putEvents(ACCOUNT, [entry('a', 1, 'k1')]);
    expect(bus.putEvents(OTHER_ACCOUNT, [entry('a', 1, 'k1')])[0]?.SuccessCode).toBe('PUBLISHED');
  });

  test('ungrouped entries share one scope per account', () => {
    const bus = new BusModel();
    const ungrouped: PutEventsRequestEntry = { Source: 'com.example', DetailType: 'X', Detail: '{}', SystemMetadata: { DeduplicationId: 'k' } };
    bus.putEvents(ACCOUNT, [ungrouped]);
    expect(bus.putEvents(ACCOUNT, [{ ...ungrouped, Detail: '{"other":true}' }])[0]?.SuccessCode).toBe('DEDUPLICATED');
  });

  test('CONTENT_BASED catches identical content without a key', () => {
    const bus = new BusModel();
    const e: PutEventsRequestEntry = { Source: 'com.example', DetailType: 'X', Detail: '{"n":1}', SystemMetadata: { EventGroupId: 'g' } };
    const dedup = { DeduplicationType: 'CONTENT_BASED' };
    expect(bus.putEvents(ACCOUNT, [e], dedup)[0]?.SuccessCode).toBe('PUBLISHED');
    expect(bus.putEvents(ACCOUNT, [e], dedup)[0]?.SuccessCode).toBe('DEDUPLICATED');
    expect(bus.putEvents(ACCOUNT, [{ ...e, Detail: '{"n":2}' }], dedup)[0]?.SuccessCode).toBe('PUBLISHED');
  });

  test('without a key or CONTENT_BASED, nothing is deduplicated', () => {
    const bus = new BusModel();
    const e: PutEventsRequestEntry = { Source: 'com.example', DetailType: 'X', Detail: '{}' };
    bus.putEvents(ACCOUNT, [e]);
    expect(bus.putEvents(ACCOUNT, [e])[0]?.SuccessCode).toBe('PUBLISHED');
  });

  test('rejects reserved aws. sources and more than 100 entries', () => {
    const bus = new BusModel();
    expect(bus.putEvents(ACCOUNT, [{ Source: 'aws.s3', DetailType: 'X', Detail: '{}' }])[0]?.ErrorCode).toBeDefined();
    expect(() => bus.putEvents(ACCOUNT, Array.from({ length: 101 }, () => entry('a', 1)))).toThrow(/1 to 100/);
  });
});

describe('FIFO subscriber', () => {
  test('delivers each group in publish order', async () => {
    const bus = new BusModel();
    const got: DeliveredEvent[][] = [];
    bus.createSubscriber({ name: 'fifo', type: 'FIFO', maxBatchSize: 2, target: async (b) => void got.push(b) });
    for (let v = 1; v <= 5; v += 1) bus.putEvents(ACCOUNT, [entry('a', v), entry('b', v)]);
    await bus.drain();
    const seq = versions(got);
    expect(seq.filter((s) => s.startsWith('a:'))).toEqual(['a:v1', 'a:v2', 'a:v3', 'a:v4', 'a:v5']);
    expect(seq.filter((s) => s.startsWith('b:'))).toEqual(['b:v1', 'b:v2', 'b:v3', 'b:v4', 'b:v5']);
  });

  test('a failing event holds up its own group only, then goes to the dead-letter queue', async () => {
    const bus = new BusModel();
    const got: DeliveredEvent[][] = [];
    const dlq: DeadLetterRecord[] = [];
    bus.createSubscriber({
      name: 'fifo',
      type: 'FIFO',
      maxBatchSize: 1,
      retry: { maxRetryAttempts: 2, maxEventAgeSeconds: 3600 },
      deadLetter: dlq,
      target: async (batch) => {
        const d = batch[0]?.Data.detail as { orderId: string; version: number };
        if (d.orderId === 'a' && d.version === 2) throw Object.assign(new Error('boom'), { code: 'COMPUTE_EXECUTION_ERROR' });
        got.push(batch);
      },
    });
    bus.putEvents(ACCOUNT, [entry('a', 1), entry('b', 1)]);
    bus.putEvents(ACCOUNT, [entry('a', 2), entry('b', 2)]);
    bus.putEvents(ACCOUNT, [entry('a', 3), entry('b', 3)]);

    await bus.pump(); // a:v1, b:v1
    await bus.pump(); // a:v2 fails, b:v2
    await bus.pump(); // a:v2 fails again, b:v3
    expect(versions(got)).toEqual(['a:v1', 'b:v1', 'b:v2', 'b:v3']); // a:v3 is still waiting behind a:v2
    await bus.pump(); // third failure exhausts 1 + 2 retries; a:v2 goes to the DLQ
    await bus.pump(); // a:v3 now flows
    expect(versions(got)).toEqual(['a:v1', 'b:v1', 'b:v2', 'b:v3', 'a:v3']);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({ exhaustedRetryCondition: 'MaximumRetryAttempts', retryAttempts: 2, errorCode: 'COMPUTE_EXECUTION_ERROR' });
    expect(dlq[0]?.failedMessages[0]?.eventGroupId).toBe('a');
  });

  test('MaxEventAgeInSeconds ends retries too', async () => {
    const bus = new BusModel();
    const dlq: DeadLetterRecord[] = [];
    bus.createSubscriber({
      name: 'fifo', type: 'FIFO', retry: { maxRetryAttempts: 185, maxEventAgeSeconds: 60 }, deadLetter: dlq,
      target: async () => { throw new Error('down'); },
    });
    bus.putEvents(ACCOUNT, [entry('a', 1)]);
    await bus.drain(10_000);
    expect(dlq[0]?.exhaustedRetryCondition).toBe('MaximumEventAgeInSeconds');
  });

  test('without a dead-letter queue, an exhausted event is dropped and only counted', async () => {
    const bus = new BusModel();
    bus.createSubscriber({ name: 'fifo', type: 'FIFO', retry: { maxRetryAttempts: 0, maxEventAgeSeconds: 60 }, target: async () => { throw new Error('x'); } });
    bus.putEvents(ACCOUNT, [entry('a', 1)]);
    await bus.drain();
    expect(bus.stats('fifo').dropped).toBe(1);
  });
});

describe('UNORDERED subscriber', () => {
  test('can deliver a group out of order', async () => {
    const bus = new BusModel({ seed: 7 });
    const got: DeliveredEvent[][] = [];
    bus.createSubscriber({ name: 'any', type: 'UNORDERED', maxBatchSize: 1, target: async (b) => void got.push(b) });
    for (let v = 1; v <= 6; v += 1) bus.putEvents(ACCOUNT, [entry('a', v)]);
    await bus.drain();
    const seq = versions(got);
    expect([...seq].sort()).toEqual(['a:v1', 'a:v2', 'a:v3', 'a:v4', 'a:v5', 'a:v6']);
    expect(seq).not.toEqual([...seq].sort());
  });
});

describe('retention and replay', () => {
  test('LATEST misses events published before the subscriber existed', async () => {
    const bus = new BusModel();
    bus.putEvents(ACCOUNT, [entry('a', 1)]);
    const got: DeliveredEvent[][] = [];
    bus.createSubscriber({ name: 'late', type: 'FIFO', target: async (b) => void got.push(b) });
    await bus.drain();
    expect(got).toHaveLength(0);
  });

  test('POINT_IN_TIME HORIZON reads retained history marked REPLAY, then live events marked LIVE', async () => {
    const bus = new BusModel({ retentionDays: 7 });
    bus.putEvents(ACCOUNT, [entry('a', 1)]);
    bus.advance(1000);
    const got: DeliveredEvent[][] = [];
    bus.createSubscriber({ name: 'rebuild', type: 'FIFO', startingPosition: { type: 'POINT_IN_TIME', pointType: 'HORIZON' }, target: async (b) => void got.push(b) });
    bus.putEvents(ACCOUNT, [entry('a', 2)]);
    await bus.drain();
    expect(got.flat().map((d) => d.SystemMetadata['aws:DeliveryType'])).toEqual(['REPLAY', 'LIVE']);
  });

  test('events older than the retention period are gone, and a start point before the window is refused', () => {
    const bus = new BusModel({ retentionDays: 1 });
    bus.putEvents(ACCOUNT, [entry('a', 1)]);
    bus.advance(86_400_000 + 1);
    expect(bus.storedEvents()).toHaveLength(0);
    expect(() =>
      bus.createSubscriber({ name: 'x', type: 'FIFO', startingPosition: { type: 'POINT_IN_TIME', pointType: 'TIMESTAMP', startingPoint: bus.createdAt }, target: async () => {} }),
    ).toThrow(/retention window/);
  });

  test('on a new bus, the window starts at the bus creation time', () => {
    const bus = new BusModel({ retentionDays: 30 });
    expect(bus.retentionWindowStart()).toBe(bus.createdAt);
  });

  test('a TIMESTAMP replay with an end point stops there', async () => {
    const bus = new BusModel({ retentionDays: 7 });
    const t0 = bus.clock();
    bus.putEvents(ACCOUNT, [entry('a', 1)]);
    bus.advance(60_000);
    bus.putEvents(ACCOUNT, [entry('a', 2)]);
    bus.advance(60_000);
    const got: DeliveredEvent[][] = [];
    bus.createSubscriber({
      name: 'window', type: 'FIFO',
      startingPosition: { type: 'POINT_IN_TIME', pointType: 'TIMESTAMP', startingPoint: t0, endPoint: t0 + 30_000 },
      target: async (b) => void got.push(b),
    });
    await bus.drain();
    expect(versions(got)).toEqual(['a:v1']);
  });

  test('a stopped subscriber keeps its backlog and resumes from LAST_PROCESSED, or skips it with LATEST', async () => {
    const bus = new BusModel();
    const got: DeliveredEvent[][] = [];
    const other: DeliveredEvent[][] = [];
    bus.createSubscriber({ name: 's1', type: 'FIFO', target: async (b) => void got.push(b) });
    bus.createSubscriber({ name: 's2', type: 'FIFO', target: async (b) => void other.push(b) });
    bus.stopSubscriber('s1');
    bus.stopSubscriber('s2');
    bus.putEvents(ACCOUNT, [entry('a', 1)]);
    await bus.drain();
    bus.resumeSubscriber('s1', 'LAST_PROCESSED');
    bus.resumeSubscriber('s2', 'LATEST');
    await bus.drain();
    expect(versions(got)).toEqual(['a:v1']);
    expect(other).toHaveLength(0);
  });
});

describe('filters', () => {
  test('every filter must match (AND), and one filter per scope', async () => {
    const bus = new BusModel();
    const got: DeliveredEvent[][] = [];
    bus.createSubscriber({
      name: 'f', type: 'UNORDERED', target: async (b) => void got.push(b),
      filters: [
        { scope: 'SYSTEM_METADATA', pattern: '{"aws:Source":["com.infratales.orders"]}' },
        { scope: 'DATA', pattern: '{"detail":{"version":[{"numeric":[">",1]}]}}' },
      ],
    });
    bus.putEvents(ACCOUNT, [entry('a', 1), entry('a', 2), { Source: 'com.example', DetailType: 'X', Detail: '{"version":5}' }]);
    await bus.drain();
    expect(versions(got)).toEqual(['a:v2']);
    expect(() =>
      bus.createSubscriber({ name: 'g', type: 'FIFO', target: async () => {}, filters: [{ scope: 'DATA', pattern: '{}' }, { scope: 'DATA', pattern: '{}' }] }),
    ).toThrow(/one filter per scope/);
  });
});
