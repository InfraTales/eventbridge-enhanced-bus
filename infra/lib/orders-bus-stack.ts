import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EventBusV2, SubscriberV2 } from './eventsv2';
import { ANALYTICS_JSONATA, DETAIL_TYPE_FILTER, SOURCE_FILTER } from './expressions';

/** esbuild output, one folder per function. See scripts/bundle.ts. */
export const BUILD_DIR = path.join(__dirname, '..', '..', 'build');
export const FUNCTIONS = ['publisher', 'ledger'] as const;

/**
 * The ledger function must finish before EventBridge stops waiting. Otherwise EventBridge
 * records EXECUTION_TIMEOUT and retries while the first run may still complete.
 */
export const LEDGER_INVOCATION_TIMEOUT_SECONDS = 30;
export const LEDGER_FUNCTION_TIMEOUT_SECONDS = 20;

export interface OrdersBusStackProps extends cdk.StackProps {
  /** Days the bus keeps events, 1 to 365. Default 7. */
  retentionDays?: number;
  /** Optional email for dead-letter alarms. */
  alertEmail?: string;
  /**
   * Adds a replay subscriber that feeds the ledger from this time (epoch seconds).
   * Deploy it to rebuild the ledger from the bus; remove it when it has caught up.
   */
  replayFromEpochSeconds?: number;
}

/** Reads and checks the optional context values. */
export function parseContext(app: Construct): Pick<OrdersBusStackProps, 'retentionDays' | 'alertEmail' | 'replayFromEpochSeconds'> {
  const get = (k: string): unknown => app.node.tryGetContext(k);
  const retention = get('retentionDays');
  const email = get('alertEmail');
  const replay = get('replayFromEpochSeconds');
  const asInt = (name: string, v: unknown): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(v)}`);
    return n;
  };
  if (email !== undefined && (typeof email !== 'string' || !email.includes('@'))) {
    throw new Error(`alertEmail must be an email address, got ${JSON.stringify(email)}`);
  }
  return {
    retentionDays: asInt('retentionDays', retention),
    alertEmail: email,
    replayFromEpochSeconds: asInt('replayFromEpochSeconds', replay),
  };
}

export class OrdersBusStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OrdersBusStackProps = {}) {
    super(scope, id, props);

    const bus = new EventBusV2(this, 'OrdersBus', {
      name: `${this.stackName}-orders`,
      description: 'Order status events. FIFO per order for the ledger, unordered for analytics.',
      retentionPeriodInDays: props.retentionDays ?? 7,
    });

    // ----- Publisher -----
    const publisher = this.nodeFunction('Publisher', 'publisher', 10, { EVENT_BUS_ARN: bus.eventBusArn });
    publisher.addToRolePolicy(
      new iam.PolicyStatement({
        // The IAM prefix is events:, not eventsv2:. An eventsv2: action grants nothing.
        actions: ['events:PutEvents'],
        resources: [bus.eventBusArn],
      }),
    );

    // ----- Ordered subscriber: bus -> ledger Lambda -> DynamoDB -----
    const ledgerTable = new dynamodb.Table(this, 'LedgerTable', {
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // The ledger is a projection. You can rebuild it from the bus with a replay subscriber.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const ledger = this.nodeFunction('Ledger', 'ledger', LEDGER_FUNCTION_TIMEOUT_SECONDS, { LEDGER_TABLE: ledgerTable.tableName });
    ledger.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [ledgerTable.tableArn] }));

    // A FIFO subscriber needs a FIFO dead-letter queue. EventBridge sets MessageGroupId from
    // the EventGroupId. Content-based dedup is on because the docs don't say whether
    // EventBridge sets a MessageDeduplicationId on dead-letter records.
    const ledgerDlq = new sqs.Queue(this, 'LedgerDeadLetterQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const ledgerDeliveryRole = this.deliveryRole('LedgerDeliveryRole', [
      new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [ledger.functionArn] }),
      new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [ledgerDlq.queueArn] }),
    ]);
    const ledgerSubscriberProps = {
      eventBusArn: bus.eventBusArn,
      type: 'FIFO' as const,
      filters: [
        { scope: 'SYSTEM_METADATA' as const, pattern: SOURCE_FILTER },
        { scope: 'DATA' as const, pattern: DETAIL_TYPE_FILTER },
      ],
      // The ledger needs aws:DeliveryType and EventGroupId as well as the data.
      transformer: { type: 'WITH_METADATA' as const },
      invoke: {
        targetArn: ledger.functionArn,
        roleArn: ledgerDeliveryRole.roleArn,
        // Synchronous: a thrown error is a failed delivery, and the group waits for the retry.
        lambda: { invocationType: 'REQUEST_RESPONSE' as const, invocationTimeoutSeconds: LEDGER_INVOCATION_TIMEOUT_SECONDS },
      },
      batch: { maxBatchSize: 10, maxBatchWindowInSeconds: 0 },
      // A failing event blocks its order for this long, then goes to the dead-letter queue.
      retry: { maxRetryAttempts: 10, maxEventAgeInSeconds: 3600 },
      deadLetterQueueArn: ledgerDlq.queueArn,
    };
    const ledgerSubscriber = new SubscriberV2(this, 'LedgerSubscriber', {
      ...ledgerSubscriberProps,
      name: `${this.stackName}-ledger`,
    });
    this.afterRolePolicy(ledgerSubscriber, ledgerDeliveryRole);

    if (props.replayFromEpochSeconds !== undefined) {
      const rebuild = new SubscriberV2(this, 'LedgerReplaySubscriber', {
        ...ledgerSubscriberProps,
        name: `${this.stackName}-ledger-replay`,
        startingPosition: {
          type: 'POINT_IN_TIME',
          pointType: 'TIMESTAMP',
          startingPointEpochSeconds: props.replayFromEpochSeconds,
        },
      });
      this.afterRolePolicy(rebuild, ledgerDeliveryRole);
    }

    // ----- Unordered subscriber: bus -> JSONata -> analytics queue -----
    const analyticsQueueDlq = new sqs.Queue(this, 'AnalyticsConsumerDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const analyticsQueue = new sqs.Queue(this, 'AnalyticsQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: analyticsQueueDlq, maxReceiveCount: 5 },
    });
    const analyticsDeliveryDlq = new sqs.Queue(this, 'AnalyticsDeliveryDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    const analyticsDeliveryRole = this.deliveryRole('AnalyticsDeliveryRole', [
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [analyticsQueue.queueArn, analyticsDeliveryDlq.queueArn],
      }),
    ]);
    const analyticsSubscriber = new SubscriberV2(this, 'AnalyticsSubscriber', {
      name: `${this.stackName}-analytics`,
      eventBusArn: bus.eventBusArn,
      type: 'UNORDERED',
      filters: [
        { scope: 'SYSTEM_METADATA', pattern: SOURCE_FILTER },
        { scope: 'DATA', pattern: DETAIL_TYPE_FILTER },
      ],
      transformer: { type: 'JSONATA', expression: ANALYTICS_JSONATA },
      invoke: { targetArn: analyticsQueue.queueArn, roleArn: analyticsDeliveryRole.roleArn },
      // Classic targets retried for 24 hours. The enhanced bus defaults to 5 attempts or 300 s.
      retry: { maxRetryAttempts: 185, maxEventAgeInSeconds: 86_400 },
      deadLetterQueueArn: analyticsDeliveryDlq.queueArn,
    });
    this.afterRolePolicy(analyticsSubscriber, analyticsDeliveryRole);

    // ----- Alarms: any dead-letter record means an event missed its target -----
    const topic = props.alertEmail ? new sns.Topic(this, 'Alerts', { enforceSSL: true }) : undefined;
    if (topic && props.alertEmail) {
      new sns.Subscription(this, 'AlertEmail', { topic, protocol: sns.SubscriptionProtocol.EMAIL, endpoint: props.alertEmail });
    }
    for (const [name, queue] of [
      ['LedgerDeadLetters', ledgerDlq],
      ['AnalyticsDeliveryDeadLetters', analyticsDeliveryDlq],
      ['AnalyticsConsumerDeadLetters', analyticsQueueDlq],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, `${name}Alarm`, {
        metric: queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name}: an event ran out of retries. Read the record, fix the cause, replay from the bus.`,
      });
      if (topic) alarm.addAlarmAction(new cwActions.SnsAction(topic));
    }

    new cdk.CfnOutput(this, 'EventBusArn', { value: bus.eventBusArn });
    new cdk.CfnOutput(this, 'PublisherFunctionName', { value: publisher.functionName });
    new cdk.CfnOutput(this, 'LedgerTableName', { value: ledgerTable.tableName });
    new cdk.CfnOutput(this, 'AnalyticsQueueUrl', { value: analyticsQueue.queueUrl });

    this.acknowledgeFindings([publisher, ledger], ledgerDlq, analyticsDeliveryDlq, analyticsQueueDlq);
  }

  private nodeFunction(id: string, dir: (typeof FUNCTIONS)[number], timeoutSeconds: number, environment: Record<string, string>): lambda.Function {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // An explicit role with only the log permissions this function needs, instead of the
    // AWSLambdaBasicExecutionRole managed policy.
    const role = new iam.Role(this, `${id}Role`, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(
      new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }),
    );
    return new lambda.Function(this, id, {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(BUILD_DIR, dir)),
      memorySize: 256,
      timeout: cdk.Duration.seconds(timeoutSeconds),
      environment: { ...environment, NODE_OPTIONS: '--enable-source-maps' },
      logGroup,
      role,
    });
  }

  /** A role EventBridge assumes to deliver. Same account as the subscriber, as the docs require. */
  private deliveryRole(id: string, statements: iam.PolicyStatement[]): iam.Role {
    const role = new iam.Role(this, id, { assumedBy: new iam.ServicePrincipal('events.amazonaws.com') });
    for (const s of statements) role.addToPolicy(s);
    return role;
  }

  /**
   * CloudFormation would otherwise create the subscriber as soon as the role exists, maybe
   * before its policy is attached, and the first deliveries would fail with ACCESS_DENIED.
   */
  private afterRolePolicy(subscriber: SubscriberV2, role: iam.Role): void {
    const policy = role.node.tryFindChild('DefaultPolicy');
    if (!policy) throw new Error(`role ${role.node.id} has no DefaultPolicy`);
    subscriber.resource.node.addDependency(policy);
  }

  private acknowledgeFindings(functions: lambda.Function[], ...deadLetterQueues: sqs.Queue[]): void {
    const ack = (scope: Construct, id: string, reason: string) => cdk.Validations.of(scope).acknowledge({ id, reason });
    for (const fn of functions) {
      ack(fn, 'AwsSolutions-L1', 'nodejs24.x is the newest Lambda Node.js runtime; cdk-nag may not list it yet.');
    }
    for (const q of deadLetterQueues) {
      ack(q, 'AwsSolutions-SQS3', 'This queue is itself a dead-letter queue. Records here are read by people, then deleted.');
    }
  }
}
