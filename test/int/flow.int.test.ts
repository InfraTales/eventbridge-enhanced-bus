/**
 * End to end through the real handlers' logic, with the bus MODEL in the middle and
 * DynamoDB Local behind the ledger:
 *
 *   publishInOrder -> (PutEvents, mocked into the model) -> FIFO subscriber -> processDelivery -> DynamoDB Local
 *                                                         -> UNORDERED subscriber -> JSONata -> fake queue
 *
 * The filter patterns and the JSONata expression are the same strings the stack deploys.
 */
import { EventBridgeV2Client, PutEventsCommand, type PutEventsRequestEntry } from '@aws-sdk/client-eventbridgev2';
import { mockClient } from 'aws-sdk-client-mock';
import jsonata from 'jsonata';
import { ANALYTICS_JSONATA, DETAIL_TYPE_FILTER, SOURCE_FILTER } from '../../infra/lib/expressions';
import { processDelivery } from '../../src/ledger/process';
import { DynamoLedgerStore } from '../../src/ledger/store';
import { BusModel, type DeadLetterRecord, type DeliveredEvent } from '../../src/model/bus-model';
import { publishInOrder } from '../../src/publisher/publish';
import { orderEvent } from '../support/fixtures';
import { createLedgerTable, localClient } from './support';

const ACCOUNT = '123456789012';
const BUS = 'arn:aws:events:us-east-1:123456789012:event-busv2/orders/abcdefghijklmnopqrstuvwxy';
const ebMock = mockClient(EventBridgeV2Client);
const ddb = localClient();
const noSleep = async () => {};
const filters = [
  { scope: 'SYSTEM_METADATA' as const, pattern: SOURCE_FILTER },
  { scope: 'DATA' as const, pattern: DETAIL_TYPE_FILTER },
];
const transform = jsonata(ANALYTICS_JSONATA.replace(/^\{%/, '').replace(/%\}$/, ''));

let table: Awaited<ReturnType<typeof createLedgerTable>>;
beforeEach(async () => {
  ebMock.reset();
  table = await createLedgerTable(ddb);
});
afterEach(async () => table.drop());
afterAll(() => ddb.destroy());

function setup(retentionDays = 7) {
  const bus = new BusModel({ retentionDays });
  ebMock.on(PutEventsCommand).callsFake((input: { Entries: PutEventsRequestEntry[] }) => ({ Entries: bus.putEvents(ACCOUNT, input.Entries) }));
  const store = new DynamoLedgerStore(table.name, ddb, () => new Date(bus.clock()));
  const analytics: unknown[] = [];
  const ledgerDlq: DeadLetterRecord[] = [];
  bus.createSubscriber({
    name: 'ledger', type: 'FIFO', filters, maxBatchSize: 10, deadLetter: ledgerDlq,
    retry: { maxRetryAttempts: 10, maxEventAgeSeconds: 3600 },
    target: async (batch) => void (await processDelivery(batch, store)),
  });
  bus.createSubscriber({
    name: 'analytics', type: 'UNORDERED', filters,
    target: async (batch) => {
      for (const d of batch) analytics.push(await transform.evaluate({}, { events: d }));
    },
  });
  return { bus, store, analytics, ledgerDlq, client: new EventBridgeV2Client({}) };
}

test('orders land in the ledger at their latest version; analytics gets one flat record per event', async () => {
  const { bus, store, analytics, client } = setup();
  const events = [1, 2, 3].flatMap((v) => [orderEvent('A', v), orderEvent('B', v)]);
  await publishInOrder(client, BUS, events, { sleep: noSleep });
  // A producer retry of the whole request: every entry comes back DEDUPLICATED.
  const retry = await publishInOrder(client, BUS, events, { sleep: noSleep });
  expect(retry.deduplicated).toHaveLength(6);
  await bus.drain();
  expect((await store.get('A'))?.version).toBe(3);
  expect((await store.get('B'))?.status).toBe('SHIPPED');
  expect(analytics).toHaveLength(6);
  expect(analytics[0]).toEqual(expect.objectContaining({ orderId: expect.any(String), replay: false }));
});

test('events from another source never reach either subscriber', async () => {
  const { bus, analytics } = setup();
  bus.putEvents(ACCOUNT, [{ Source: 'com.example.other', DetailType: 'OrderStatusChanged', Detail: JSON.stringify(orderEvent('X', 1)) }]);
  await bus.drain();
  expect(analytics).toHaveLength(0);
  expect(bus.stats('ledger').delivered).toBe(0);
});

test('a DynamoDB outage holds up the ledger, then it catches up in order without losing events', async () => {
  const { bus, store, client, ledgerDlq } = setup();
  const realApply = store.apply.bind(store);
  let down = true;
  store.apply = async (e) => {
    if (down) throw new Error('DynamoDB unavailable');
    return realApply(e);
  };
  await publishInOrder(client, BUS, [orderEvent('A', 1), orderEvent('A', 2)], { sleep: noSleep });
  await bus.pump();
  await bus.pump();
  expect(await store.get('A')).toBeUndefined();
  down = false;
  await bus.drain();
  expect((await store.get('A'))?.version).toBe(2);
  expect(ledgerDlq).toEqual([]);
});

test('a replay subscriber rebuilds an empty ledger from retained events, and replaying again changes nothing', async () => {
  const { bus, store, client } = setup();
  await publishInOrder(client, BUS, [1, 2, 3, 4].map((v) => orderEvent('A', v)), { sleep: noSleep });
  await bus.drain();
  // Lose the projection, as if the table were recreated.
  await table.drop();
  table = await createLedgerTable(ddb);
  const rebuilt = new DynamoLedgerStore(table.name, ddb);
  const replayed: DeliveredEvent[] = [];
  bus.advance(60_000);
  bus.createSubscriber({
    name: 'rebuild', type: 'FIFO', filters, startingPosition: { type: 'POINT_IN_TIME', pointType: 'HORIZON' },
    target: async (batch) => {
      replayed.push(...batch);
      await processDelivery(batch, rebuilt);
    },
  });
  await bus.drain();
  expect((await rebuilt.get('A'))?.version).toBe(4);
  expect(replayed.every((d) => d.SystemMetadata['aws:DeliveryType'] === 'REPLAY')).toBe(true);
  expect(await processDelivery(replayed, rebuilt)).toEqual({ applied: 0, stale: 4, replayed: 4 });
  expect(store).toBeDefined();
});

test('an UNORDERED subscriber feeding the same ledger still ends at the latest version, thanks to the version guard', async () => {
  const { bus, client } = setup();
  const unorderedStore = new DynamoLedgerStore(table.name, ddb);
  bus.createSubscriber({ name: 'unordered-ledger', type: 'UNORDERED', filters, maxBatchSize: 1, target: async (b) => void (await processDelivery(b, unorderedStore)) });
  await publishInOrder(client, BUS, [1, 2, 3, 4, 5].map((v) => orderEvent('U', v)), { sleep: noSleep });
  await bus.drain();
  expect((await unorderedStore.get('U'))?.version).toBe(5);
});
