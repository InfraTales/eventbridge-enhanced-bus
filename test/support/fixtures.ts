import type { OrderStatus, OrderStatusChanged } from '../../src/contract/order-events';

let counter = 0;

/** Builds a valid event. Each call gets a fresh eventId unless one is given. */
export function orderEvent(orderId: string, version: number, overrides: Partial<OrderStatusChanged> = {}): OrderStatusChanged {
  counter += 1;
  const statuses: OrderStatus[] = ['PLACED', 'PAID', 'SHIPPED', 'CANCELLED'];
  return {
    eventId: `evt-${orderId}-v${version}-${counter.toString().padStart(4, '0')}`,
    orderId,
    version,
    status: statuses[Math.min(version - 1, 2)] as OrderStatus,
    totalCents: 4250,
    currency: 'USD',
    occurredAt: new Date(Date.UTC(2026, 9, 1, 12, 0, version)).toISOString(),
    ...overrides,
  };
}
