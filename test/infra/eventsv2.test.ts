import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EventBusV2, SubscriberV2, type SubscriberProps } from '../../infra/lib/eventsv2';

const base = (): SubscriberProps => ({
  name: 's',
  eventBusArn: 'arn:aws:events:us-east-1:123456789012:event-busv2/orders/abcdefghijklmnopqrstuvwxy',
  type: 'FIFO',
  invoke: {
    targetArn: 'arn:aws:lambda:us-east-1:123456789012:function:f',
    roleArn: 'arn:aws:iam::123456789012:role/r',
    lambda: { invocationType: 'REQUEST_RESPONSE' },
  },
  retry: { maxRetryAttempts: 5, maxEventAgeInSeconds: 300 },
  deadLetterQueueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq.fifo',
});
const make = (patch: Partial<SubscriberProps>) => new SubscriberV2(new cdk.Stack(), 'S', { ...base(), ...patch });

test('refuses a FIFO subscriber that hands events to Lambda asynchronously', () => {
  expect(() => make({ invoke: { ...base().invoke, lambda: { invocationType: 'EVENT' } } })).toThrow(/REQUEST_RESPONSE/);
});

test.each([
  ['retry attempts above 185', { retry: { maxRetryAttempts: 186, maxEventAgeInSeconds: 300 } }, /0 to 185/],
  ['event age under 60 s', { retry: { maxRetryAttempts: 5, maxEventAgeInSeconds: 59 } }, /60 to 86,400/],
  ['batch above 500', { batch: { maxBatchSize: 501 } }, /1 to 500/],
  ['two DATA filters', { filters: [{ scope: 'DATA' as const, pattern: '{}' }, { scope: 'DATA' as const, pattern: '{}' }] }, /one filter per scope/],
  ['invalid JSON pattern', { filters: [{ scope: 'DATA' as const, pattern: '{nope' }] }, /JSON/],
  ['patterns over 4,096 bytes', { filters: [{ scope: 'DATA' as const, pattern: JSON.stringify({ a: ['x'.repeat(4100)] }) }] }, /4,096/],
])('refuses %s', (_name, patch, message) => {
  expect(() => make(patch as Partial<SubscriberProps>)).toThrow(message);
});

test('writes InvocationTimeoutSeconds as a string, the CloudFormation type', () => {
  const stack = new cdk.Stack();
  new SubscriberV2(stack, 'S', { ...base(), invoke: { ...base().invoke, lambda: { invocationType: 'REQUEST_RESPONSE', invocationTimeoutSeconds: 12 } } });
  Template.fromStack(stack).hasResourceProperties('AWS::EventsV2::Subscriber', {
    InvokeConfiguration: { LambdaParameters: { InvocationType: 'REQUEST_RESPONSE', InvocationTimeoutSeconds: '12' } },
  });
});

test('a HORIZON replay sets PointType only', () => {
  const stack = new cdk.Stack();
  new SubscriberV2(stack, 'S', { ...base(), startingPosition: { type: 'POINT_IN_TIME', pointType: 'HORIZON' } });
  Template.fromStack(stack).hasResourceProperties('AWS::EventsV2::Subscriber', {
    StartingPosition: 'POINT_IN_TIME',
    PointInTimeConfiguration: { PointType: 'HORIZON' },
  });
});

test('an event bus without a KMS key leaves EncryptionConfiguration out', () => {
  const stack = new cdk.Stack();
  new EventBusV2(stack, 'B', { name: 'b', retentionPeriodInDays: 1 });
  const bus = Object.values<any>(Template.fromStack(stack).findResources('AWS::EventsV2::EventBus'))[0];
  expect(bus.Properties).toEqual({ Name: 'b', StorageConfiguration: { RetentionPeriodInDays: 1 } });
});
