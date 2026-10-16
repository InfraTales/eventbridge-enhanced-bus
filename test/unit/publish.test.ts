import { EventBridgeV2Client, PutEventsCommand, type PutEventsRequestEntry } from '@aws-sdk/client-eventbridgev2';
import { mockClient } from 'aws-sdk-client-mock';
import { MAX_ENTRIES_PER_CALL, publishInOrder } from '../../src/publisher/publish';
import { BusModel } from '../../src/model/bus-model';
import { orderEvent } from '../support/fixtures';

const BUS = 'arn:aws:events:us-east-1:123456789012:event-busv2/orders/abcdefghijklmnopqrstuvwxy';
const ACCOUNT = '123456789012';
const noSleep = async () => {};
const ebMock = mockClient(EventBridgeV2Client);

/** Routes PutEvents calls into the bus model, so tests see what the bus would store. */
function wireToModel(bus: BusModel) {
  ebMock.on(PutEventsCommand).callsFake((input: { Entries: PutEventsRequestEntry[]; DeduplicationConfiguration?: { DeduplicationType?: string } }) => {
    const Entries = bus.putEvents(ACCOUNT, input.Entries, input.DeduplicationConfiguration);
    return { Entries, FailedEntryCount: Entries.filter((e) => e.ErrorCode).length };
  });
}
const stored = (bus: BusModel) => bus.storedEvents().map((e) => {
  const d = e.detail as { orderId: string; version: number };
  return `${d.orderId}:v${d.version}`;
});

beforeEach(() => ebMock.reset());

test('sends at most one entry per order in each PutEvents call', async () => {
  const bus = new BusModel();
  wireToModel(bus);
  const events = [orderEvent('a', 1), orderEvent('a', 2), orderEvent('a', 3), orderEvent('b', 1)];
  const report = await publishInOrder(new EventBridgeV2Client({}), BUS, events, { sleep: noSleep });
  for (const call of ebMock.commandCalls(PutEventsCommand)) {
    const groups = (call.args[0].input.Entries ?? []).map((e) => e.SystemMetadata?.EventGroupId);
    expect(new Set(groups).size).toBe(groups.length);
  }
  expect(report.calls).toBe(3);
  expect(report.published).toHaveLength(4);
});

test('a failed entry is retried before the next version of its order, so the bus keeps version order', async () => {
  const bus = new BusModel();
  wireToModel(bus);
  const a1 = orderEvent('a', 1);
  bus.injectPublishFailure((e) => e.SystemMetadata?.DeduplicationId === a1.eventId, 1);
  const report = await publishInOrder(new EventBridgeV2Client({}), BUS, [a1, orderEvent('a', 2), orderEvent('b', 1)], { sleep: noSleep });
  expect(report.failed).toEqual([]);
  expect(stored(bus).filter((s) => s.startsWith('a:'))).toEqual(['a:v1', 'a:v2']);
});

test('sorts each order by version even when the input is shuffled', async () => {
  const bus = new BusModel();
  wireToModel(bus);
  await publishInOrder(new EventBridgeV2Client({}), BUS, [orderEvent('a', 3), orderEvent('a', 1), orderEvent('a', 2)], { sleep: noSleep });
  expect(stored(bus)).toEqual(['a:v1', 'a:v2', 'a:v3']);
});

test('DEDUPLICATED counts as success: a whole retried request stores nothing new', async () => {
  const bus = new BusModel();
  wireToModel(bus);
  const events = [orderEvent('a', 1), orderEvent('a', 2)];
  const client = new EventBridgeV2Client({});
  await publishInOrder(client, BUS, events, { sleep: noSleep });
  const again = await publishInOrder(client, BUS, events, { sleep: noSleep });
  expect(again).toMatchObject({ published: [], failed: [], notSent: [] });
  expect(again.deduplicated).toEqual(events.map((e) => e.eventId));
  expect(bus.storedEvents()).toHaveLength(2);
});

test('an entry that keeps failing halts its order; later versions are not sent; other orders finish', async () => {
  const bus = new BusModel();
  wireToModel(bus);
  const a2 = orderEvent('a', 2);
  const a3 = orderEvent('a', 3);
  bus.injectPublishFailure((e) => e.SystemMetadata?.DeduplicationId === a2.eventId, 99, 'ThrottlingException');
  const sleeps: number[] = [];
  const report = await publishInOrder(new EventBridgeV2Client({}), BUS, [orderEvent('a', 1), a2, a3, orderEvent('b', 1)], {
    maxAttempts: 3,
    sleep: async (ms) => void sleeps.push(ms),
  });
  expect(report.failed).toEqual([{ eventId: a2.eventId, orderId: 'a', errorCode: 'ThrottlingException', errorMessage: 'injected by the model' }]);
  expect(report.notSent).toEqual([a3.eventId]);
  expect(stored(bus)).toEqual(['a:v1', 'b:v1']);
  expect(sleeps).toEqual([100, 200, 400]); // backs off between rounds with failures
});

test('splits more than 100 orders across calls', async () => {
  const bus = new BusModel();
  wireToModel(bus);
  const events = Array.from({ length: MAX_ENTRIES_PER_CALL + 5 }, (_, i) => orderEvent(`o${i}`, 1));
  const report = await publishInOrder(new EventBridgeV2Client({}), BUS, events, { sleep: noSleep });
  expect(report.calls).toBe(2);
  expect(bus.storedEvents()).toHaveLength(105);
});

test('refuses to guess when the response has the wrong number of results', async () => {
  ebMock.on(PutEventsCommand).resolves({ Entries: [] });
  await expect(publishInOrder(new EventBridgeV2Client({}), BUS, [orderEvent('a', 1)], { sleep: noSleep })).rejects.toThrow(/0 results for 1/);
});
