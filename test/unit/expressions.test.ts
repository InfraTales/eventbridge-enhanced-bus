/**
 * Contract tests for the strings the stack deploys: the filter patterns and the
 * analytics JSONata expression, run against the delivered-event shape the docs describe.
 *
 * JSONata is evaluated with the open source jsonata library. EventBridge runs its own
 * JSONata engine with six extra functions; this expression uses none of them.
 */
import jsonata from 'jsonata';
import { toPutEventsEntry } from '../../src/contract/order-events';
import { BusModel, type DeliveredEvent } from '../../src/model/bus-model';
import { matchesPattern } from '../../src/model/pattern';
import { ANALYTICS_JSONATA, DETAIL_TYPE_FILTER, SOURCE_FILTER } from '../../infra/lib/expressions';
import { orderEvent } from '../support/fixtures';

/** EventBridge wants one complete expression inside {% %}. Strip the delimiters to evaluate it. */
function unwrap(expr: string): string {
  const m = /^\{%([\s\S]*)%\}$/.exec(expr);
  if (!m) throw new Error('expression must be wrapped in {% %}');
  return m[1] as string;
}

async function deliveredFor(deliveryType: 'LIVE' | 'REPLAY' = 'LIVE'): Promise<DeliveredEvent> {
  const bus = new BusModel({ retentionDays: 2 });
  const got: DeliveredEvent[] = [];
  const e = orderEvent('order-42', 2, { totalCents: 1999 });
  if (deliveryType === 'REPLAY') {
    bus.putEvents('123456789012', [toPutEventsEntry(e)]);
    bus.advance(1000); // published before the subscriber existed
  }
  bus.createSubscriber({
    name: 's', type: 'UNORDERED',
    startingPosition: deliveryType === 'REPLAY' ? { type: 'POINT_IN_TIME', pointType: 'HORIZON' } : { type: 'LATEST' },
    target: async (b) => void got.push(...b),
  });
  if (deliveryType === 'LIVE') bus.putEvents('123456789012', [toPutEventsEntry(e)]);
  await bus.drain();
  return got[0] as DeliveredEvent;
}

test('the analytics expression is under the 8,192 character limit and wrapped in {% %}', () => {
  expect(ANALYTICS_JSONATA.length).toBeLessThanOrEqual(8192);
  expect(() => unwrap(ANALYTICS_JSONATA)).not.toThrow();
});

test('the analytics expression turns a PutEvents event into a flat record', async () => {
  const d = await deliveredFor();
  const out: unknown = await jsonata(unwrap(ANALYTICS_JSONATA)).evaluate({}, { events: d });
  expect(out).toEqual({
    orderId: 'order-42',
    status: 'PAID',
    totalCents: 1999,
    currency: 'USD',
    occurredAt: (d.Data.detail as { occurredAt: string }).occurredAt,
    busEventId: d.SystemMetadata['aws:EventId'],
    replay: false,
  });
});

test('replayed events are flagged, so analytics can tell them apart', async () => {
  const d = await deliveredFor('REPLAY');
  const out = (await jsonata(unwrap(ANALYTICS_JSONATA)).evaluate({}, { events: d })) as { replay: boolean };
  expect(out.replay).toBe(true);
});

test('written for the wrong API shape, the expression yields nothing, which fails delivery', async () => {
  // PutRawEvents data has our fields at the top of Data. Our expression reads Data.detail,
  // so a raw event produces an object with no fields. EventBridge would deliver {} or fail.
  const d = await deliveredFor();
  const raw = { ...d, Data: d.Data.detail as Record<string, unknown> };
  const out = (await jsonata(unwrap(ANALYTICS_JSONATA)).evaluate({}, { events: raw })) as Record<string, unknown>;
  expect(out.orderId).toBeUndefined();
});

test('both filters match our events, in the scope each one is deployed to', async () => {
  const d = await deliveredFor();
  expect(matchesPattern(SOURCE_FILTER, d.SystemMetadata)).toBe(true);
  expect(matchesPattern(DETAIL_TYPE_FILTER, d.Data)).toBe(true);
});

test('the source filter would match nothing if deployed to the DATA scope', async () => {
  // aws:Source lives in SystemMetadata. A wrong-scope filter doesn't fail; it matches nothing.
  const d = await deliveredFor();
  expect(matchesPattern(SOURCE_FILTER, d.Data)).toBe(false);
});

test('the filters fit the 4,096 byte limit and use no wildcards', () => {
  expect(Buffer.byteLength(SOURCE_FILTER) + Buffer.byteLength(DETAIL_TYPE_FILTER)).toBeLessThanOrEqual(4096);
  expect(SOURCE_FILTER + DETAIL_TYPE_FILTER).not.toMatch(/wildcard/);
});
