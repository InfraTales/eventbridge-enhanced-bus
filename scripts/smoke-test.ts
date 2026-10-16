/**
 * Smoke test against a deployed stack (npm run deploy first). Not run in CI.
 *
 * 1. Invokes the publisher with three versions of one order, twice. The second call
 *    must come back all DEDUPLICATED.
 * 2. Waits for the ledger to show version 3.
 * 3. Reads the analytics queue and checks the JSONata output shape.
 *
 * Uses your normal AWS credentials and region. Stack name defaults to OrdersBus.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { OrderStatusChanged } from '../src/contract/order-events';
import { DynamoLedgerStore } from '../src/ledger/store';
import type { PublishReport } from '../src/publisher/publish';

const stackName = process.env.STACK_NAME ?? 'OrdersBus';
const deadline = Date.now() + 120_000;

async function outputs(): Promise<Record<string, string>> {
  const out = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((out.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
}

async function publish(fn: string, events: OrderStatusChanged[]): Promise<PublishReport> {
  const res = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify({ events })) }));
  const body = Buffer.from(res.Payload ?? new Uint8Array()).toString();
  if (res.FunctionError) throw new Error(`publisher failed: ${body}`);
  return JSON.parse(body) as PublishReport;
}

async function main(): Promise<void> {
  const o = await outputs();
  const orderId = `smoke-${randomUUID().slice(0, 8)}`;
  const statuses = ['PLACED', 'PAID', 'SHIPPED'] as const;
  const events: OrderStatusChanged[] = statuses.map((status, i) => ({
    eventId: randomUUID(),
    orderId,
    version: i + 1,
    status,
    totalCents: 4250,
    currency: 'USD',
    occurredAt: new Date().toISOString(),
  }));

  const first = await publish(o.PublisherFunctionName as string, events);
  const second = await publish(o.PublisherFunctionName as string, events);
  console.log('first publish:', first);
  console.log('second publish:', second);
  if (first.published.length !== 3) throw new Error('expected 3 PUBLISHED on the first call');
  if (second.deduplicated.length !== 3) throw new Error('expected 3 DEDUPLICATED on the second call (within 5 minutes)');

  const store = new DynamoLedgerStore(o.LedgerTableName as string, new DynamoDBClient({}));
  for (;;) {
    const item = await store.get(orderId);
    if (item?.version === 3) {
      console.log('ledger:', item);
      break;
    }
    if (Date.now() > deadline) throw new Error(`ledger did not reach version 3, last seen ${JSON.stringify(item)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  const sqs = new SQSClient({});
  const seen = new Set<number>();
  while (seen.size < 3) {
    if (Date.now() > deadline) throw new Error(`analytics queue had ${seen.size} of 3 records`);
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: o.AnalyticsQueueUrl, WaitTimeSeconds: 10, MaxNumberOfMessages: 10 }));
    for (const m of res.Messages ?? []) {
      const record = JSON.parse(m.Body ?? '{}') as { orderId?: string; status?: string; replay?: boolean };
      if (record.orderId === orderId) {
        seen.add(statuses.indexOf(record.status as (typeof statuses)[number]));
        if (record.replay !== false) throw new Error(`expected replay=false, got ${JSON.stringify(record)}`);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: o.AnalyticsQueueUrl, ReceiptHandle: m.ReceiptHandle }));
      }
    }
  }
  console.log('smoke test passed');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
