import { ContractError, DETAIL_TYPE, SOURCE, parseDelivered, parseOrderStatusChanged, toPutEventsEntry } from '../../src/contract/order-events';
import { orderEvent } from '../support/fixtures';

describe('OrderStatusChanged contract', () => {
  test('a valid event round-trips unchanged', () => {
    const e = orderEvent('order-1', 1);
    expect(parseOrderStatusChanged(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  test.each([
    ['eventId', { eventId: 'short' }],
    ['orderId with a space', { orderId: 'order 1' }],
    ['orderId over 64 chars', { orderId: 'a'.repeat(65) }],
    ['version 0', { version: 0 }],
    ['fractional version', { version: 1.5 }],
    ['unknown status', { status: 'LOST' }],
    ['negative total', { totalCents: -1 }],
    ['lowercase currency', { currency: 'usd' }],
    ['bad time', { occurredAt: 'yesterday' }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseOrderStatusChanged({ ...orderEvent('order-1', 1), ...patch })).toThrow(ContractError);
  });

  test('rejects unknown fields, so a producer change cannot slip through silently', () => {
    expect(() => parseOrderStatusChanged({ ...orderEvent('order-1', 1), discount: 5 })).toThrow(/unknown fields: discount/);
  });
});

describe('PutEvents entry shape', () => {
  test('groups by order and deduplicates by the producer event ID', () => {
    const e = orderEvent('order-7', 3);
    const entry = toPutEventsEntry(e);
    expect(entry).toEqual({
      Source: SOURCE,
      DetailType: DETAIL_TYPE,
      Detail: JSON.stringify(e),
      Time: new Date(e.occurredAt),
      SystemMetadata: { EventGroupId: 'order-7', DeduplicationId: e.eventId },
    });
  });

  test('the source never starts with aws., which publishers may not use', () => {
    expect(SOURCE.startsWith('aws.')).toBe(false);
  });
});

describe('delivered WITH_METADATA shape', () => {
  const e = orderEvent('order-9', 2);
  const delivered = (sys: Record<string, string>) => ({
    Data: { version: '0', id: 'x', 'detail-type': DETAIL_TYPE, source: SOURCE, time: e.occurredAt, detail: e },
    Metadata: {},
    SystemMetadata: { 'aws:DeliveryType': 'LIVE', EventGroupId: 'order-9', ...sys },
  });

  test('parses data, group and delivery type', () => {
    expect(parseDelivered(delivered({ 'aws:DeliveryType': 'REPLAY', 'aws:EventId': 'bus-1' }))).toEqual({
      event: e,
      eventGroupId: 'order-9',
      deliveryType: 'REPLAY',
      busEventId: 'bus-1',
    });
  });

  test('rejects a group that disagrees with the order ID', () => {
    expect(() => parseDelivered(delivered({ EventGroupId: 'order-1' }))).toThrow(/EventGroupId/);
  });

  test('rejects a RAW payload, which has no SystemMetadata', () => {
    expect(() => parseDelivered(e)).toThrow(ContractError);
  });

  test('rejects another source', () => {
    const d = delivered({});
    expect(() => parseDelivered({ ...d, Data: { ...d.Data, source: 'com.example.other' } })).toThrow(/source/);
  });
});
