# Runbook

## A dead-letter alarm fired

Each dead-letter queue has an alarm that fires on one or more visible messages.

| Alarm | What failed | Records look like |
|---|---|---|
| LedgerDeadLetters | The ledger subscriber ran out of retries (10 attempts or 1 hour) | EventBridge dead-letter records, FIFO, grouped by order ID |
| AnalyticsDeliveryDeadLetters | Delivery to the analytics queue ran out of retries (185 attempts or 24 hours) | EventBridge dead-letter records |
| AnalyticsConsumerDeadLetters | Whatever reads the analytics queue failed 5 times on a message | The analytics record itself |

An EventBridge dead-letter record holds the error, not the event. Read `errorCode` first. The [retry docs](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-custom-bus-retry.html) list every code. For the ledger, the usual causes are:

- `COMPUTE_EXECUTION_ERROR`: the function threw. Check its logs for a contract error or a DynamoDB error.
- `EXECUTION_TIMEOUT`: the function didn't return within 30 seconds. Its own timeout is 20 seconds, so look for cold starts or throttling.
- `ACCESS_DENIED`: the delivery role or a key policy changed.

## Redrive by replay

The dead-letter queue holds records rather than events, so you redrive by replaying from the bus, and that only works while the events are inside the retention window (7 days by default).

1. Fix the cause.
2. Note the earliest `failedMessages[].timestamp` in the records.
3. Deploy with `-c replayFromEpochSeconds=<that time in unix seconds, minus a minute>`. This adds `<stack>-ledger-replay`, a FIFO subscriber that starts there and delivers to the same function.
4. The ledger write only applies newer versions, so the ledger skips events it already has. Each replayed event carries `aws:DeliveryType` `REPLAY`.
5. Once the replay subscriber has caught up, deploy again without the flag and delete the records from the dead-letter queue.

A replay starts after a delay and then runs at live speed. The docs say EventBridge limits how many subscribers can replay at once on one bus.

## Rebuild the ledger from scratch

Delete the table's items, or the stack's table, and run the replay above from the start of the retention window. Events older than the retention period are gone.

## Pause a subscriber

`aws eventsv2 update-subscriber --subscriber-arn <arn> --state STOPPED` pauses delivery while events keep building up on the bus. Resume with `--state RUNNING --resume-position LAST_PROCESSED` to get the backlog, or `LATEST` to skip it. If the stack sets `State`, a later deploy can flip it back, so pause outside CloudFormation only for short operations.

## Changes that replace a subscriber

Changing `Name`, `EventBusArn`, the target ARN, `Type`, `StartingPosition` or `PointInTimeConfiguration` replaces the subscriber. CloudFormation deletes the old one first, and a new `LATEST` subscriber misses events published in the gap. Deploy the new subscriber alongside the old one first, or give the new one a `POINT_IN_TIME` start from before the deploy.
