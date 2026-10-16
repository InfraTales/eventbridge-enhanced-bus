# Security

## IAM

- The publisher's role allows `events:PutEvents` on this bus's ARN and nothing else on EventBridge. The prefix is `events:`. The docs warn that IAM accepts `eventsv2:PutEvents` but no such action exists, so a policy written that way grants nothing.
- Each subscriber has its own delivery role. Each role trusts only `events.amazonaws.com` and lives in the same account as its subscriber, as the docs require.
- The ledger delivery role can invoke one function and send to one dead-letter queue. The analytics delivery role can send to the analytics queue and its dead-letter queue. A template test fails if any of these grants widens.
- The ledger function can call `dynamodb:PutItem` on its table and write to its own log group. It uses no AWS managed policies.
- The stack creates each subscriber only after its role's policy exists. Otherwise the first deliveries could fail with `ACCESS_DENIED` while CloudFormation was still attaching the policy.

We don't add `aws:SourceAccount` or `aws:SourceArn` conditions to the delivery role trust policies. The enhanced bus docs don't say whether EventBridge sends those keys when it assumes a delivery role, and a wrong condition would stop every delivery. Add them once you've confirmed the behaviour in your account.

## Filters are routing, not access control

Both subscribers filter on `aws:Source` in `SYSTEM_METADATA`. EventBridge writes that field, and no publisher can set a source that starts with `aws.`. That stops anyone posing as an AWS service. Any principal allowed to publish to the bus can still send `com.infratales.orders`, so the publish permission is the real boundary. To share the bus with other accounts, use AWS Resource Access Manager with the narrowest managed permission (for example `AWSRAMEventBridgeEventBusV2PublishOnly`). Remember that unsharing doesn't stop subscribers another account already created. You have to revoke them with `RevokeResource`.

## Validation

The publisher validates every event against the contract in `src/contract/order-events.ts` before anything reaches the bus. It refuses unknown fields. Order IDs can hold up to 64 letters, digits and hyphens, because they become the `EventGroupId` and the FIFO dead-letter queue's `MessageGroupId`. The ledger validates again on delivery and fails the delivery on a contract error. The event then goes to the dead-letter queue after its retries.

## Encryption

- The bus uses an AWS owned key, the default. To use a customer managed AWS KMS key, set `kmsKeyIdentifier` on `EventBusV2` and give EventBridge the key permissions listed in the [encryption docs](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-custom-bus-encryption.html).
- All four SQS queues use SQS managed encryption and refuse requests that don't use TLS.
- The DynamoDB table uses the default AWS owned key and has point-in-time recovery turned on.

## Logs

The functions log counts and IDs and leave the order contents out. CloudWatch keeps the logs for one month.
