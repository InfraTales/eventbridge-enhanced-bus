import { EventBridgeV2Client, PutEventsCommand } from '@aws-sdk/client-eventbridgev2';
import { mockClient } from 'aws-sdk-client-mock';
import { orderEvent } from '../support/fixtures';

const ebMock = mockClient(EventBridgeV2Client);
const BUS = 'arn:aws:events:us-east-1:123456789012:event-busv2/orders/abcdefghijklmnopqrstuvwxy';

beforeEach(() => {
  ebMock.reset();
  process.env.EVENT_BUS_ARN = BUS;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

// Imported after the mock is installed, as Lambda would load it.
const load = async () => (await import('../../src/publisher/handler')).handler;

test('publishes to the configured bus', async () => {
  ebMock.on(PutEventsCommand).resolves({ Entries: [{ SuccessCode: 'PUBLISHED', EventId: 'e1' }] });
  const handler = await load();
  const report = await handler({ events: [orderEvent('a', 1)] });
  expect(report.published).toHaveLength(1);
  expect(ebMock.commandCalls(PutEventsCommand)[0]?.args[0].input.EventBusArn).toBe(BUS);
});

test('rejects the whole request on a contract error, before calling EventBridge', async () => {
  const handler = await load();
  await expect(handler({ events: [orderEvent('a', 1), { ...orderEvent('b', 1), currency: 'dollars' }] })).rejects.toThrow(/currency/);
  expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
});

test('fails the invocation when an event could not be published, so the caller retries', async () => {
  ebMock.on(PutEventsCommand).resolves({ Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'x' }] });
  const handler = await load();
  await expect(handler({ events: [orderEvent('a', 1)] })).rejects.toThrow(/failed to publish 1/);
});

test('fails at once without EVENT_BUS_ARN', async () => {
  delete process.env.EVENT_BUS_ARN;
  const handler = await load();
  await expect(handler({ events: [orderEvent('a', 1)] })).rejects.toThrow(/EVENT_BUS_ARN/);
});

test('rejects an empty request', async () => {
  const handler = await load();
  await expect(handler({ events: [] })).rejects.toThrow(/at least one/);
});
