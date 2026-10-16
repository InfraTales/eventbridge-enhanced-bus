/**
 * Filter patterns and the JSONata expression, kept in one place so the stack and the
 * contract tests use the exact same strings.
 */
import { DETAIL_TYPE, SOURCE } from '../../src/contract/order-events';

/**
 * aws:Source sits in SystemMetadata, which only EventBridge writes. For PutEvents it is
 * the entry's Source. Publishers can't use an "aws." source, so this can't be spoofed
 * as an AWS service event; any publisher allowed on the bus can still send our source.
 */
export const SOURCE_FILTER = JSON.stringify({ 'aws:Source': [SOURCE] });

/** PutEvents data is the EventBridge envelope, so detail-type is at the top of Data. */
export const DETAIL_TYPE_FILTER = JSON.stringify({ 'detail-type': [DETAIL_TYPE] });

/**
 * What the analytics queue receives: a flat record per event. Our fields are under
 * $events.Data.detail because the publisher uses PutEvents.
 */
export const ANALYTICS_JSONATA =
  '{% {' +
  '"orderId": $events.Data.detail.orderId, ' +
  '"status": $events.Data.detail.status, ' +
  '"totalCents": $events.Data.detail.totalCents, ' +
  '"currency": $events.Data.detail.currency, ' +
  '"occurredAt": $events.Data.detail.occurredAt, ' +
  '"busEventId": $events.SystemMetadata."aws:EventId", ' +
  '"replay": $events.SystemMetadata."aws:DeliveryType" = "REPLAY"' +
  '} %}';
