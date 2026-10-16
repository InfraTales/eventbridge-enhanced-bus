/**
 * Typed wrappers for the AWS::EventsV2 CloudFormation resource types.
 *
 * Why CfnResource: aws-cdk-lib 2.273.0 ships generated L1 classes in aws-eventsv2, but
 * its CfnSubscriber has no `invokeConfiguration` property, and CloudFormation requires
 * InvokeConfiguration (TargetArn and RoleArn) on every subscriber. So we declare both
 * resource types with cdk.CfnResource, using the property names from the CloudFormation
 * template reference:
 *   https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-eventsv2-eventbus.html
 *   https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-eventsv2-subscriber.html
 * The interfaces below cover only the properties this repo uses.
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface EventBusProps {
  name: string;
  description?: string;
  /** 1 to 365. The bus keeps every event this long; subscribers can replay from inside the window. */
  retentionPeriodInDays: number;
  /** Omit for an AWS owned key. */
  kmsKeyIdentifier?: string;
}

export class EventBusV2 extends Construct {
  readonly resource: cdk.CfnResource;
  /** Ref returns the bus ARN, which ends in an ID that EventBridge generates. */
  readonly eventBusArn: string;

  constructor(scope: Construct, id: string, props: EventBusProps) {
    super(scope, id);
    if (!Number.isInteger(props.retentionPeriodInDays) || props.retentionPeriodInDays < 1 || props.retentionPeriodInDays > 365) {
      throw new Error('retentionPeriodInDays must be an integer from 1 to 365');
    }
    this.resource = new cdk.CfnResource(this, 'Resource', {
      type: 'AWS::EventsV2::EventBus',
      properties: {
        Name: props.name,
        Description: props.description,
        StorageConfiguration: { RetentionPeriodInDays: props.retentionPeriodInDays },
        EncryptionConfiguration: props.kmsKeyIdentifier ? { KmsKeyIdentifier: props.kmsKeyIdentifier } : undefined,
      },
    });
    this.eventBusArn = this.resource.ref;
  }
}

export type FilterScope = 'DATA' | 'METADATA' | 'SYSTEM_METADATA';

export interface SubscriberProps {
  name: string;
  eventBusArn: string;
  /** Create-only: changing it replaces the subscriber. */
  type: 'FIFO' | 'UNORDERED';
  filters?: { scope: FilterScope; pattern: string }[];
  transformer?: { type: 'RAW' | 'WITH_METADATA' } | { type: 'JSONATA'; expression: string };
  invoke: {
    targetArn: string;
    roleArn: string;
    lambda?: { invocationType: 'EVENT' | 'REQUEST_RESPONSE'; invocationTimeoutSeconds?: number };
    sqs?: { messageGroupId?: string; messageDeduplicationId?: string };
  };
  batch?: { maxBatchSize?: number; maxBatchWindowInSeconds?: number };
  retry: { maxRetryAttempts: number; maxEventAgeInSeconds: number };
  /** The SQS queue that receives a record for each event that ran out of retries. */
  deadLetterQueueArn: string;
  /** Create-only. Default LATEST. */
  startingPosition?:
    | { type: 'LATEST' }
    | { type: 'POINT_IN_TIME'; pointType: 'HORIZON' }
    | { type: 'POINT_IN_TIME'; pointType: 'TIMESTAMP'; startingPointEpochSeconds: number; endPointEpochSeconds?: number };
}

export class SubscriberV2 extends Construct {
  readonly resource: cdk.CfnResource;

  constructor(scope: Construct, id: string, props: SubscriberProps) {
    super(scope, id);
    const { retry, batch, invoke } = props;
    if (!Number.isInteger(retry.maxRetryAttempts) || retry.maxRetryAttempts < 0 || retry.maxRetryAttempts > 185) {
      throw new Error('maxRetryAttempts must be 0 to 185');
    }
    if (!Number.isInteger(retry.maxEventAgeInSeconds) || retry.maxEventAgeInSeconds < 60 || retry.maxEventAgeInSeconds > 86_400) {
      throw new Error('maxEventAgeInSeconds must be 60 to 86,400');
    }
    if (batch?.maxBatchSize !== undefined && (batch.maxBatchSize < 1 || batch.maxBatchSize > 500)) {
      throw new Error('maxBatchSize must be 1 to 500');
    }
    const timeout = invoke.lambda?.invocationTimeoutSeconds;
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 30)) {
      throw new Error('invocationTimeoutSeconds must be 1 to 30');
    }
    const scopes = (props.filters ?? []).map((f) => f.scope);
    if (new Set(scopes).size !== scopes.length) throw new Error('at most one filter per scope');
    const filterBytes = (props.filters ?? []).reduce((n, f) => n + Buffer.byteLength(f.pattern), 0);
    if (filterBytes > 4096) throw new Error('filters share a 4,096 byte limit');
    for (const f of props.filters ?? []) JSON.parse(f.pattern); // must be valid JSON
    // A FIFO subscriber that hands events to Lambda asynchronously only keeps order up to Lambda's queue.
    if (props.type === 'FIFO' && invoke.lambda && invoke.lambda.invocationType !== 'REQUEST_RESPONSE') {
      throw new Error('a FIFO subscriber with a Lambda target must use REQUEST_RESPONSE to keep order');
    }

    const pos = props.startingPosition ?? { type: 'LATEST' };
    this.resource = new cdk.CfnResource(this, 'Resource', {
      type: 'AWS::EventsV2::Subscriber',
      properties: {
        Name: props.name,
        EventBusArn: props.eventBusArn,
        Type: props.type,
        FilterConfiguration: props.filters?.length
          ? { Filters: props.filters.map((f) => ({ Scope: f.scope, Pattern: f.pattern })) }
          : undefined,
        Transformer: props.transformer
          ? props.transformer.type === 'JSONATA'
            ? { Type: 'JSONATA', JsonataConfiguration: { Expression: props.transformer.expression } }
            : { Type: props.transformer.type }
          : undefined,
        InvokeConfiguration: {
          TargetArn: invoke.targetArn,
          RoleArn: invoke.roleArn,
          LambdaParameters: invoke.lambda
            ? {
                InvocationType: invoke.lambda.invocationType,
                // The CloudFormation type of this field is String.
                InvocationTimeoutSeconds: timeout === undefined ? undefined : String(timeout),
              }
            : undefined,
          SqsParameters: invoke.sqs
            ? { MessageGroupId: invoke.sqs.messageGroupId, MessageDeduplicationId: invoke.sqs.messageDeduplicationId }
            : undefined,
        },
        BatchConfiguration: batch
          ? { MaxBatchSize: batch.maxBatchSize, MaxBatchWindowInSeconds: batch.maxBatchWindowInSeconds }
          : undefined,
        RetryPolicy: { MaxRetryAttempts: retry.maxRetryAttempts, MaxEventAgeInSeconds: retry.maxEventAgeInSeconds },
        OnFailureConfiguration: { Arn: props.deadLetterQueueArn },
        StartingPosition: pos.type,
        PointInTimeConfiguration:
          pos.type === 'POINT_IN_TIME'
            ? pos.pointType === 'HORIZON'
              ? { PointType: 'HORIZON' }
              : { PointType: 'TIMESTAMP', StartingPoint: pos.startingPointEpochSeconds, EndPoint: pos.endPointEpochSeconds }
            : undefined,
      },
    });
  }
}
