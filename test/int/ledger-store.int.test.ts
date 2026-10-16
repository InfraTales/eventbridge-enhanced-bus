/**
 * The ledger's conditional write, run on a real DynamoDB engine (DynamoDB Local).
 */
import { DynamoLedgerStore } from '../../src/ledger/store';
import { orderEvent } from '../support/fixtures';
import { createLedgerTable, localClient } from './support';

const client = localClient();
let table: Awaited<ReturnType<typeof createLedgerTable>>;
let store: DynamoLedgerStore;

beforeEach(async () => {
  table = await createLedgerTable(client);
  store = new DynamoLedgerStore(table.name, client);
});
afterEach(async () => table.drop());
afterAll(() => client.destroy());

test('the first event for an order is applied', async () => {
  const e = orderEvent('o1', 1);
  expect(await store.apply(e)).toBe('applied');
  expect(await store.get('o1')).toMatchObject({ ...e, lastEventId: e.eventId });
});

test('a newer version replaces the stored one', async () => {
  await store.apply(orderEvent('o1', 1));
  expect(await store.apply(orderEvent('o1', 2))).toBe('applied');
  expect((await store.get('o1'))?.version).toBe(2);
});

test('an older version arriving late is refused and changes nothing', async () => {
  const v2 = orderEvent('o1', 2);
  await store.apply(v2);
  expect(await store.apply(orderEvent('o1', 1))).toBe('stale');
  expect(await store.get('o1')).toMatchObject({ version: 2, lastEventId: v2.eventId });
});

test('the same version delivered twice (retry or replay) is refused the second time', async () => {
  const v1 = orderEvent('o1', 1);
  await store.apply(v1);
  expect(await store.apply({ ...v1, status: 'CANCELLED' })).toBe('stale');
  expect((await store.get('o1'))?.status).toBe('PLACED');
});

test('concurrent writers of versions 1 to 20 leave the highest version, and each version applies at most once', async () => {
  const events = Array.from({ length: 20 }, (_, i) => orderEvent('race', i + 1));
  // Shuffle so the engine sees them in a mixed order, all at once.
  const shuffled = [...events].sort(() => 0.5 - Math.random());
  const results = await Promise.all(shuffled.map((e) => store.apply(e)));
  expect((await store.get('race'))?.version).toBe(20);
  expect(results.filter((r) => r === 'applied').length).toBeGreaterThanOrEqual(1);
  // v20 must have won its own write: nothing can be newer.
  expect(results[shuffled.findIndex((e) => e.version === 20)]).toBe('applied');
});

test('non-conditional errors are not swallowed', async () => {
  const broken = new DynamoLedgerStore('no-such-table', client);
  await expect(broken.apply(orderEvent('o1', 1))).rejects.toThrow(/non-existent table|ResourceNotFound|Cannot do operations/);
});
