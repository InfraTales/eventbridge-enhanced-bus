/**
 * Publisher Lambda. Takes { events: OrderStatusChanged[] }, validates each one against
 * the contract, and publishes them in per-order version order.
 *
 * In a real system this would sit behind your order service's outbox. Here you invoke
 * it directly (see scripts/smoke-test.ts).
 */
import { EventBridgeV2Client } from '@aws-sdk/client-eventbridgev2';
import { requireEnv } from '../config';
import { parseOrderStatusChanged } from '../contract/order-events';
import { publishInOrder, type PublishReport } from './publish';

const client = new EventBridgeV2Client({});

export async function handler(input: unknown): Promise<PublishReport> {
  const eventBusArn = requireEnv('EVENT_BUS_ARN');
  const raw = (input as { events?: unknown } | null)?.events;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('input must be { events: [...] } with at least one event');
  }
  // Reject the whole request on a contract error, before anything reaches the bus.
  const events = raw.map(parseOrderStatusChanged);
  const report = await publishInOrder(client, eventBusArn, events);
  console.log(
    JSON.stringify({
      msg: 'publish finished',
      published: report.published.length,
      deduplicated: report.deduplicated.length,
      failed: report.failed.length,
      notSent: report.notSent.length,
      calls: report.calls,
    }),
  );
  if (report.failed.length > 0) {
    // Fail the invocation so the caller retries. Accepted events will come back DEDUPLICATED.
    throw new Error(`failed to publish ${report.failed.length} event(s): ${JSON.stringify(report.failed)}`);
  }
  return report;
}
