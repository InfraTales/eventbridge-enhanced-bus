import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import {
  LEDGER_FUNCTION_TIMEOUT_SECONDS,
  LEDGER_INVOCATION_TIMEOUT_SECONDS,
  OrdersBusStack,
  parseContext,
} from '../../infra/lib/orders-bus-stack';
import { ANALYTICS_JSONATA, DETAIL_TYPE_FILTER, SOURCE_FILTER } from '../../infra/lib/expressions';

const env = { account: '123456789012', region: 'us-east-1' };
const build = (props: ConstructorParameters<typeof OrdersBusStack>[2] = {}) => {
  const app = new cdk.App();
  const stack = new OrdersBusStack(app, 'Test', { env, ...props });
  return { app, stack, template: Template.fromStack(stack) };
};
const { template } = build();

const subscribers = (t: Template) => Object.values<any>(t.findResources('AWS::EventsV2::Subscriber'));
const subscriber = (t: Template, suffix: string) => {
  const s = subscribers(t).find((r) => r.Properties.Name === `Test-${suffix}`);
  expect(s).toBeDefined();
  return s;
};
const roleStatements = (logicalPrefix: string) => {
  const policies = template.findResources('AWS::IAM::Policy');
  const entry = Object.entries<any>(policies).find(([id]) => id.startsWith(logicalPrefix));
  expect(entry).toBeDefined();
  return entry![1].Properties.PolicyDocument.Statement as any[];
};

describe('the bus', () => {
  test('is an AWS::EventsV2::EventBus with 7 days of retention by default', () => {
    template.resourceCountIs('AWS::EventsV2::EventBus', 1);
    template.hasResourceProperties('AWS::EventsV2::EventBus', {
      Name: 'Test-orders',
      StorageConfiguration: { RetentionPeriodInDays: 7 },
    });
  });

  test('retention is configurable and checked', () => {
    build({ retentionDays: 30 }).template.hasResourceProperties('AWS::EventsV2::EventBus', { StorageConfiguration: { RetentionPeriodInDays: 30 } });
    expect(() => build({ retentionDays: 366 })).toThrow(/1 to 365/);
  });

  test('uses no Classic AWS::Events resources', () => {
    expect(Object.keys(template.toJSON().Resources).filter((k) => template.toJSON().Resources[k].Type.startsWith('AWS::Events::'))).toEqual([]);
  });
});

describe('the ordered ledger subscriber', () => {
  const s = subscriber(template, 'ledger');

  test('is FIFO, synchronous, and sees metadata', () => {
    expect(s.Properties.Type).toBe('FIFO');
    expect(s.Properties.Transformer).toEqual({ Type: 'WITH_METADATA' });
    expect(s.Properties.InvokeConfiguration.LambdaParameters).toEqual({
      InvocationType: 'REQUEST_RESPONSE',
      InvocationTimeoutSeconds: String(LEDGER_INVOCATION_TIMEOUT_SECONDS),
    });
    expect(s.Properties.InvokeConfiguration.TargetArn).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Ledger[0-9A-F]{8}$/), 'Arn'] });
  });

  test('the function times out before EventBridge stops waiting', () => {
    expect(LEDGER_FUNCTION_TIMEOUT_SECONDS).toBeLessThan(LEDGER_INVOCATION_TIMEOUT_SECONDS);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ LEDGER_TABLE: Match.anyValue() }) },
      Timeout: LEDGER_FUNCTION_TIMEOUT_SECONDS,
    });
  });

  test('has a FIFO dead-letter queue and an explicit retry policy', () => {
    expect(s.Properties.RetryPolicy).toEqual({ MaxRetryAttempts: 10, MaxEventAgeInSeconds: 3600 });
    const dlqId = s.Properties.OnFailureConfiguration.Arn['Fn::GetAtt'][0];
    const dlq = template.toJSON().Resources[dlqId];
    expect(dlq.Type).toBe('AWS::SQS::Queue');
    expect(dlq.Properties).toMatchObject({ FifoQueue: true, ContentBasedDeduplication: true, SqsManagedSseEnabled: true });
  });

  test('filters on the verified source and the detail type', () => {
    expect(s.Properties.FilterConfiguration.Filters).toEqual([
      { Scope: 'SYSTEM_METADATA', Pattern: SOURCE_FILTER },
      { Scope: 'DATA', Pattern: DETAIL_TYPE_FILTER },
    ]);
  });

  test('is created only after its delivery role policy exists', () => {
    expect(s.DependsOn).toEqual([expect.stringMatching(/^LedgerDeliveryRoleDefaultPolicy/)]);
  });
});

describe('the unordered analytics subscriber', () => {
  const s = subscriber(template, 'analytics');

  test('is UNORDERED and shapes the payload with JSONata', () => {
    expect(s.Properties.Type).toBe('UNORDERED');
    expect(s.Properties.Transformer).toEqual({ Type: 'JSONATA', JsonataConfiguration: { Expression: ANALYTICS_JSONATA } });
    expect(s.Properties.InvokeConfiguration.TargetArn).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^AnalyticsQueue/), 'Arn'] });
    expect(s.Properties.InvokeConfiguration.LambdaParameters).toBeUndefined();
  });

  test('retries for a day like a Classic target, then dead-letters', () => {
    expect(s.Properties.RetryPolicy).toEqual({ MaxRetryAttempts: 185, MaxEventAgeInSeconds: 86400 });
    expect(s.Properties.OnFailureConfiguration.Arn['Fn::GetAtt'][0]).toMatch(/^AnalyticsDeliveryDeadLetterQueue/);
  });
});

describe('every subscriber', () => {
  test('starts at LATEST unless a replay is asked for, and every one has a dead-letter queue', () => {
    expect(subscribers(template)).toHaveLength(2);
    for (const s of subscribers(template)) {
      expect(s.Properties.StartingPosition).toBe('LATEST');
      expect(s.Properties.OnFailureConfiguration.Arn).toBeDefined();
      expect(s.Properties.InvokeConfiguration.RoleArn).toBeDefined();
    }
  });
});

describe('replay', () => {
  test('replayFromEpochSeconds adds a POINT_IN_TIME subscriber to the same ledger function', () => {
    const t = build({ replayFromEpochSeconds: 1_790_000_000 }).template;
    const replay = subscriber(t, 'ledger-replay');
    const live = subscriber(t, 'ledger');
    expect(replay.Properties.StartingPosition).toBe('POINT_IN_TIME');
    expect(replay.Properties.PointInTimeConfiguration).toEqual({ PointType: 'TIMESTAMP', StartingPoint: 1_790_000_000 });
    expect(replay.Properties.InvokeConfiguration).toEqual(live.Properties.InvokeConfiguration);
    expect(replay.Properties.Type).toBe('FIFO');
  });

  test('context values are validated', () => {
    const app = new cdk.App({ context: { replayFromEpochSeconds: 'yesterday' } });
    expect(() => parseContext(app)).toThrow(/integer/);
    expect(() => parseContext(new cdk.App({ context: { alertEmail: 'nope' } }))).toThrow(/email/);
  });
});

describe('least privilege', () => {
  test('the publisher can only PutEvents on this bus, with the events: prefix', () => {
    const st = roleStatements('PublisherRoleDefaultPolicy').filter((x) => JSON.stringify(x.Action).includes('events'));
    expect(st).toEqual([{ Effect: 'Allow', Action: 'events:PutEvents', Resource: { Ref: expect.stringMatching(/^OrdersBus/) } }]);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/eventsv2:/);
  });

  test('the ledger delivery role can invoke one function and write to its dead-letter queue, nothing else', () => {
    const st = roleStatements('LedgerDeliveryRoleDefaultPolicy');
    expect(st.map((x) => x.Action).sort()).toEqual(['lambda:InvokeFunction', 'sqs:SendMessage']);
    for (const x of st) expect(JSON.stringify(x.Resource)).not.toContain('*');
  });

  test('the analytics delivery role can send to its queue and dead-letter queue only', () => {
    const st = roleStatements('AnalyticsDeliveryRoleDefaultPolicy');
    expect(st).toHaveLength(1);
    expect(st[0].Action).toBe('sqs:SendMessage');
    expect(st[0].Resource).toHaveLength(2);
  });

  test('delivery roles trust only the EventBridge service principal', () => {
    const roles = Object.entries<any>(template.findResources('AWS::IAM::Role')).filter(([id]) => /DeliveryRole/.test(id));
    expect(roles).toHaveLength(2);
    for (const [, r] of roles) {
      expect(r.Properties.AssumeRolePolicyDocument.Statement).toEqual([
        { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' } },
      ]);
    }
  });

  test('the ledger function can only PutItem on its table', () => {
    const st = roleStatements('LedgerRoleDefaultPolicy').filter((x) => JSON.stringify(x.Action).includes('dynamodb'));
    expect(st).toEqual([{ Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: { 'Fn::GetAtt': [expect.stringMatching(/^LedgerTable/), 'Arn'] } }]);
  });
});

describe('functions and queues', () => {
  test('both functions run Node.js 24 on arm64', () => {
    const fns = Object.values<any>(template.findResources('AWS::Lambda::Function'));
    expect(fns).toHaveLength(2);
    for (const f of fns) expect(f.Properties).toMatchObject({ Runtime: 'nodejs24.x', Architectures: ['arm64'] });
  });

  test('every queue is encrypted and refuses plain HTTP', () => {
    const queues = template.findResources('AWS::SQS::Queue');
    expect(Object.keys(queues)).toHaveLength(4);
    for (const q of Object.values<any>(queues)) expect(q.Properties.SqsManagedSseEnabled).toBe(true);
    expect(Object.keys(template.findResources('AWS::SQS::QueuePolicy'))).toHaveLength(4);
  });

  test('each dead-letter queue has an alarm', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });
});

test('cdk-nag AWS Solutions finds nothing unacknowledged', () => {
  const app = new cdk.App();
  const stack = new OrdersBusStack(app, 'Nag', { env, alertEmail: 'ops@example.com', replayFromEpochSeconds: 1_790_000_000 });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  // Validation runs at synth time and throws on any unacknowledged finding.
  expect(() => app.synth()).not.toThrow();
  expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
});
