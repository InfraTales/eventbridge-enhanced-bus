/**
 * The event contract shared by the publisher and both subscribers.
 *
 * One event type: OrderStatusChanged. Each event carries the full order state and a
 * per-order version, so a consumer can apply "highest version wins" no matter how
 * the events arrive.
 */
import type { PutEventsRequestEntry } from '@aws-sdk/client-eventbridgev2';

export const SOURCE = 'com.infratales.orders';
export const DETAIL_TYPE = 'OrderStatusChanged';
export const STATUSES = ['PLACED', 'PAID', 'SHIPPED', 'CANCELLED'] as const;
export type OrderStatus = (typeof STATUSES)[number];

/**
 * Order IDs become the EventGroupId, and the ordered subscriber's FIFO dead-letter
 * queue uses the group as its MessageGroupId. Keep them short and bounded, as the
 * EventBridge docs ask, and inside the SQS FIFO character set.
 */
export const ORDER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface OrderStatusChanged {
  /** The producer's idempotency key. Sent as SystemMetadata.DeduplicationId. */
  eventId: string;
  orderId: string;
  /** Starts at 1 and goes up by one for each change to the order. */
  version: number;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  /** ISO 8601 time the change happened at the producer. */
  occurredAt: string;
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates an unknown value against the contract. Throws ContractError on any mismatch. */
export function parseOrderStatusChanged(value: unknown): OrderStatusChanged {
  if (!isRecord(value)) throw new ContractError('event must be an object');
  const { eventId, orderId, version, status, totalCents, currency, occurredAt } = value;
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) throw new ContractError('eventId is invalid');
  if (typeof orderId !== 'string' || !ORDER_ID_PATTERN.test(orderId)) throw new ContractError('orderId is invalid');
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new ContractError('version must be a positive integer');
  }
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
    throw new ContractError('status is invalid');
  }
  if (typeof totalCents !== 'number' || !Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new ContractError('totalCents must be a non-negative integer');
  }
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) throw new ContractError('currency is invalid');
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    throw new ContractError('occurredAt must be an ISO 8601 time');
  }
  const extra = Object.keys(value).filter(
    (k) => !['eventId', 'orderId', 'version', 'status', 'totalCents', 'currency', 'occurredAt'].includes(k),
  );
  if (extra.length > 0) throw new ContractError(`unknown fields: ${extra.join(', ')}`);
  return { eventId, orderId, version, status: status as OrderStatus, totalCents, currency, occurredAt };
}

/**
 * Maps one event to a PutEvents entry.
 * - EventGroupId = orderId: a FIFO subscriber delivers one order's events in publish order.
 * - DeduplicationId = eventId: a retried publish within 5 minutes comes back DEDUPLICATED.
 *   This is free; content-based deduplication is billed per event.
 */
export function toPutEventsEntry(event: OrderStatusChanged): PutEventsRequestEntry {
  return {
    Source: SOURCE,
    DetailType: DETAIL_TYPE,
    Detail: JSON.stringify(event),
    Time: new Date(event.occurredAt),
    SystemMetadata: { EventGroupId: event.orderId, DeduplicationId: event.eventId },
  };
}

/**
 * What a subscriber with Transformer.Type WITH_METADATA delivers for a PutEvents event:
 * Data is the EventBridge envelope, and our detail sits under Data.detail.
 */
export interface DeliveredEvent {
  Data: {
    version?: string;
    id?: string;
    'detail-type': string;
    source: string;
    time?: string;
    detail: unknown;
  };
  Metadata?: Record<string, string>;
  SystemMetadata: Record<string, string | undefined>;
}

export interface ParsedDelivery {
  event: OrderStatusChanged;
  eventGroupId: string | undefined;
  deliveryType: 'LIVE' | 'REPLAY';
  busEventId: string | undefined;
}

/** Validates one delivered envelope and the order event inside it. */
export function parseDelivered(value: unknown): ParsedDelivery {
  if (!isRecord(value) || !isRecord(value.Data) || !isRecord(value.SystemMetadata)) {
    throw new ContractError('delivered event must have Data and SystemMetadata objects');
  }
  const data = value.Data;
  if (data.source !== SOURCE) throw new ContractError(`unexpected source ${String(data.source)}`);
  if (data['detail-type'] !== DETAIL_TYPE) throw new ContractError(`unexpected detail-type ${String(data['detail-type'])}`);
  const event = parseOrderStatusChanged(data.detail);
  const sys = value.SystemMetadata;
  const deliveryType = sys['aws:DeliveryType'];
  if (deliveryType !== 'LIVE' && deliveryType !== 'REPLAY') {
    throw new ContractError(`aws:DeliveryType must be LIVE or REPLAY, got ${String(deliveryType)}`);
  }
  const eventGroupId = typeof sys.EventGroupId === 'string' ? sys.EventGroupId : undefined;
  if (eventGroupId !== undefined && eventGroupId !== event.orderId) {
    throw new ContractError('EventGroupId does not match orderId');
  }
  const busEventId = typeof sys['aws:EventId'] === 'string' ? sys['aws:EventId'] : undefined;
  return { event, eventGroupId, deliveryType, busEventId };
}
