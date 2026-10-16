/**
 * Applies one delivery from the ordered (FIFO) subscriber to the ledger.
 *
 * The subscriber uses Transformer.Type WITH_METADATA, so each element carries Data
 * (the PutEvents envelope) and SystemMetadata (EventGroupId, aws:DeliveryType, ...).
 * With MaxBatchSize above 1, Lambda receives a JSON array, in publish order within
 * each event group. We apply the elements one at a time, in array order: running
 * them in parallel would throw that order away.
 */
import { parseDelivered } from '../contract/order-events';
import type { ApplyResult, LedgerStore } from './store';

export interface ProcessSummary {
  applied: number;
  stale: number;
  replayed: number;
}

export async function processDelivery(payload: unknown, store: LedgerStore): Promise<ProcessSummary> {
  // MaxBatchSize 1 delivers a single object; anything else delivers an array.
  const items: unknown[] = Array.isArray(payload) ? payload : [payload];
  const summary: ProcessSummary = { applied: 0, stale: 0, replayed: 0 };
  for (const item of items) {
    // A contract error throws. With REQUEST_RESPONSE the delivery fails, EventBridge retries
    // under the subscriber's RetryPolicy, then writes a record to the FIFO dead-letter queue.
    const delivery = parseDelivered(item);
    if (delivery.deliveryType === 'REPLAY') summary.replayed += 1;
    const result: ApplyResult = await store.apply(delivery.event);
    summary[result] += 1;
  }
  return summary;
}
