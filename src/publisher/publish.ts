/**
 * Publishes order events so that each order's events reach the bus in version order.
 *
 * EventBridge accepts or rejects each entry in a PutEvents call on its own. If one
 * call held v1 and v2 of the same order and only v1 failed, a retry would land v1
 * after v2, and the FIFO subscriber would faithfully deliver them in the wrong order.
 * So each call carries at most one entry per order (EventGroupId), and an order's
 * next event waits until the previous one is accepted.
 *
 * Retries are safe because every entry has a DeduplicationId: a retry of an entry the
 * bus already stored, within 5 minutes, comes back as DEDUPLICATED.
 */
import { PutEventsCommand, type EventBridgeV2Client } from '@aws-sdk/client-eventbridgev2';
import { toPutEventsEntry, type OrderStatusChanged } from '../contract/order-events';

/** PutEvents takes 1 to 100 entries per request. */
export const MAX_ENTRIES_PER_CALL = 100;

export interface PublishOptions {
  /** Attempts per entry before its order is halted. */
  maxAttempts?: number;
  /** Waits between rounds that had failures, in ms. Injected so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
}

export interface PublishReport {
  published: string[];
  deduplicated: string[];
  /** Entries that kept failing. Their order stopped here, so nothing later was sent. */
  failed: { eventId: string; orderId: string; errorCode: string; errorMessage: string }[];
  /** Later events of a halted order. Never sent, so the bus never sees a gap filled out of order. */
  notSent: string[];
  calls: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function publishInOrder(
  client: EventBridgeV2Client,
  eventBusArn: string,
  events: OrderStatusChanged[],
  options: PublishOptions = {},
): Promise<PublishReport> {
  const maxAttempts = options.maxAttempts ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  const baseDelayMs = options.baseDelayMs ?? 100;

  // One queue per order, kept in version order. Input order breaks ties.
  const queues = new Map<string, OrderStatusChanged[]>();
  for (const event of events) {
    const queue = queues.get(event.orderId) ?? [];
    queue.push(event);
    queues.set(event.orderId, queue);
  }
  for (const queue of queues.values()) queue.sort((a, b) => a.version - b.version);

  const attempts = new Map<string, number>();
  const report: PublishReport = { published: [], deduplicated: [], failed: [], notSent: [], calls: 0 };
  let round = 0;

  while ([...queues.values()].some((q) => q.length > 0)) {
    // The head of each order's queue, at most one per order.
    const heads = [...queues.values()].filter((q) => q.length > 0).map((q) => q[0] as OrderStatusChanged);
    let roundHadFailure = false;

    for (let i = 0; i < heads.length; i += MAX_ENTRIES_PER_CALL) {
      const batch = heads.slice(i, i + MAX_ENTRIES_PER_CALL);
      report.calls += 1;
      const response = await client.send(
        new PutEventsCommand({ EventBusArn: eventBusArn, Entries: batch.map(toPutEventsEntry) }),
      );
      const results = response.Entries ?? [];
      if (results.length !== batch.length) {
        // The API promises one result per entry, in request order. Anything else is unsafe to guess about.
        throw new Error(`PutEvents returned ${results.length} results for ${batch.length} entries`);
      }

      batch.forEach((event, index) => {
        const result = results[index] ?? {};
        const queue = queues.get(event.orderId) as OrderStatusChanged[];
        if (result.SuccessCode === 'PUBLISHED' || result.SuccessCode === 'DEDUPLICATED') {
          // DEDUPLICATED is a success: the bus already holds this event.
          (result.SuccessCode === 'PUBLISHED' ? report.published : report.deduplicated).push(event.eventId);
          queue.shift();
          return;
        }
        roundHadFailure = true;
        const tries = (attempts.get(event.eventId) ?? 0) + 1;
        attempts.set(event.eventId, tries);
        if (tries >= maxAttempts) {
          report.failed.push({
            eventId: event.eventId,
            orderId: event.orderId,
            errorCode: result.ErrorCode ?? 'UNKNOWN',
            errorMessage: result.ErrorMessage ?? 'no SuccessCode and no ErrorCode in the result',
          });
          queue.shift();
          report.notSent.push(...queue.map((e) => e.eventId));
          queue.length = 0;
        }
      });
    }

    if (roundHadFailure) {
      round += 1;
      await sleep(baseDelayMs * 2 ** Math.min(round - 1, 5));
    }
  }

  return report;
}
