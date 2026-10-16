import { DETAIL_TYPE, SOURCE, type OrderStatusChanged } from '../../src/contract/order-events';
import { processDelivery } from '../../src/ledger/process';
import type { ApplyResult, LedgerStore } from '../../src/ledger/store';
import { orderEvent } from '../support/fixtures';

const wrap = (e: OrderStatusChanged, deliveryType = 'LIVE') => ({
  Data: { version: '0', id: 'x', 'detail-type': DETAIL_TYPE, source: SOURCE, time: e.occurredAt, detail: e },
  Metadata: {},
  SystemMetadata: { 'aws:DeliveryType': deliveryType, EventGroupId: e.orderId },
});

/** A store that takes a while per write and records when each write starts and ends. */
class SlowStore implements LedgerStore {
  log: string[] = [];
  versions = new Map<string, number>();
  async apply(e: OrderStatusChanged): Promise<ApplyResult> {
    this.log.push(`start ${e.orderId}:v${e.version}`);
    await new Promise((r) => setTimeout(r, 5));
    this.log.push(`end ${e.orderId}:v${e.version}`);
    const current = this.versions.get(e.orderId) ?? 0;
    if (e.version <= current) return 'stale';
    this.versions.set(e.orderId, e.version);
    return 'applied';
  }
}

test('applies a batch one event at a time, in array order', async () => {
  const store = new SlowStore();
  await processDelivery([wrap(orderEvent('a', 1)), wrap(orderEvent('a', 2))], store);
  expect(store.log).toEqual(['start a:v1', 'end a:v1', 'start a:v2', 'end a:v2']);
});

test('accepts a single object, which is what MaxBatchSize 1 delivers', async () => {
  const store = new SlowStore();
  expect(await processDelivery(wrap(orderEvent('a', 1)), store)).toEqual({ applied: 1, stale: 0, replayed: 0 });
});

test('counts replays and stale events', async () => {
  const store = new SlowStore();
  await processDelivery([wrap(orderEvent('a', 2))], store);
  const summary = await processDelivery([wrap(orderEvent('a', 1), 'REPLAY'), wrap(orderEvent('a', 2), 'REPLAY')], store);
  expect(summary).toEqual({ applied: 0, stale: 2, replayed: 2 });
});

test('throws on a contract error so EventBridge retries, then dead-letters it', async () => {
  const store = new SlowStore();
  const bad = wrap(orderEvent('a', 1));
  (bad.Data.detail as { version: unknown }).version = 'one';
  await expect(processDelivery([bad], store)).rejects.toThrow(/version/);
  expect(store.log).toEqual([]);
});
