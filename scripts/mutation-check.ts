// Breaks each safeguard on purpose, one at a time, and checks that a test fails.
// A mutant that survives means a test is missing or wrong, not the code.
//
//   npm run mutate                                                   # unit, model and infra mutants
//   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8025 npm run mutate   # plus the DynamoDB Local ones
//
// CI runs it in the dynamodb-local job, so every mutant runs there.
// A mutant only counts as killed when a test fails. If the mutated code doesn't
// compile, the script stops: a TypeScript error proves nothing about the tests.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Mutant {
  name: string;
  file: string;
  from: string;
  to: string;
  /** Jest test files (jest.config.js) that should catch it. */
  tests?: string[];
  /** DynamoDB Local test files (jest.integration.config.js). */
  int?: string[];
}

const STACK = 'test/infra/stack.test.ts';
const MODEL = 'test/unit/model.test.ts';
const PUBLISH = 'test/unit/publish.test.ts';
const STORE_INT = 'test/int/ledger-store.int.test.ts';
const FLOW_INT = 'test/int/flow.int.test.ts';
const GUARD = "ConditionExpression: 'attribute_not_exists(orderId) OR #version < :version',";

const mutants: Mutant[] = [
  {
    name: 'M1 the ledger guard lets an equal version through',
    file: 'src/ledger/store.ts',
    from: GUARD,
    to: "ConditionExpression: 'attribute_not_exists(orderId) OR #version <= :version',",
    int: [STORE_INT],
  },
  {
    name: 'M2 the ledger write has no condition',
    file: 'src/ledger/store.ts',
    from: `          ${GUARD}\n          ExpressionAttributeNames: { '#version': 'version' },\n          ExpressionAttributeValues: { ':version': event.version },\n`,
    to: '',
    int: [STORE_INT, FLOW_INT],
  },
  {
    name: "M3 the publisher sends a whole order's queue in one call",
    file: 'src/publisher/publish.ts',
    from: '.map((q) => q[0] as OrderStatusChanged);',
    to: '.flatMap((q) => q);',
    tests: [PUBLISH],
  },
  {
    name: 'M4 DEDUPLICATED is treated as a failure',
    file: 'src/publisher/publish.ts',
    from: "if (result.SuccessCode === 'PUBLISHED' || result.SuccessCode === 'DEDUPLICATED') {",
    to: "if (result.SuccessCode === 'PUBLISHED') {",
    tests: [PUBLISH],
  },
  {
    name: 'M5 the ledger applies a batch in parallel',
    file: 'src/ledger/process.ts',
    from: `  for (const item of items) {
    // A contract error throws. With REQUEST_RESPONSE the delivery fails, EventBridge retries
    // under the subscriber's RetryPolicy, then writes a record to the FIFO dead-letter queue.
    const delivery = parseDelivered(item);
    if (delivery.deliveryType === 'REPLAY') summary.replayed += 1;
    const result: ApplyResult = await store.apply(delivery.event);
    summary[result] += 1;
  }
`,
    to: `  await Promise.all(items.map(async (item) => {
    const delivery = parseDelivered(item);
    if (delivery.deliveryType === 'REPLAY') summary.replayed += 1;
    const result: ApplyResult = await store.apply(delivery.event);
    summary[result] += 1;
  }));
`,
    tests: ['test/unit/ledger-process.test.ts'],
  },
  {
    name: 'M6 the ordered subscriber invokes Lambda with EVENT',
    file: 'infra/lib/orders-bus-stack.ts',
    from: "lambda: { invocationType: 'REQUEST_RESPONSE' as const,",
    to: "lambda: { invocationType: 'EVENT' as const,",
    tests: [STACK],
  },
  {
    name: 'M7 the ordered subscriber is UNORDERED',
    file: 'infra/lib/orders-bus-stack.ts',
    from: "type: 'FIFO' as const,",
    to: "type: 'UNORDERED' as const,",
    tests: [STACK],
  },
  {
    name: 'M8 the ledger delivery role loses its dead-letter queue permission',
    file: 'infra/lib/orders-bus-stack.ts',
    from: "      new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [ledgerDlq.queueArn] }),\n",
    to: '',
    tests: [STACK],
  },
  {
    name: 'M9 the ledger subscriber no longer waits for its role policy',
    file: 'infra/lib/orders-bus-stack.ts',
    from: '    this.afterRolePolicy(ledgerSubscriber, ledgerDeliveryRole);\n',
    to: '',
    tests: [STACK],
  },
  {
    name: 'M10 the cdk-nag SQS3 acknowledgement is removed',
    file: 'infra/lib/orders-bus-stack.ts',
    from: "      ack(q, 'AwsSolutions-SQS3',",
    to: "      if (q) continue;\n      ack(q, 'AwsSolutions-SQS3',",
    tests: [STACK],
  },
  {
    name: 'M11 the ledger function timeout equals the invocation timeout',
    file: 'infra/lib/orders-bus-stack.ts',
    from: 'export const LEDGER_FUNCTION_TIMEOUT_SECONDS = 20;',
    to: 'export const LEDGER_FUNCTION_TIMEOUT_SECONDS = 30;',
    tests: [STACK],
  },
  {
    name: 'M12 model dedup ignores the event group',
    file: 'src/model/bus-model.ts',
    from: "${groupId === undefined ? 'ungrouped' : `group:${groupId}`}",
    to: "${'ungrouped'}",
    tests: [MODEL],
  },
  {
    name: 'M13 model dedup window is 10 minutes',
    file: 'src/model/bus-model.ts',
    from: 'export const DEDUP_WINDOW_MS = 300_000;',
    to: 'export const DEDUP_WINDOW_MS = 600_000;',
    tests: [MODEL],
  },
  {
    name: 'M14 model FIFO delivers like UNORDERED',
    file: 'src/model/bus-model.ts',
    from: "if (sub.spec.type === 'FIFO') await this.deliverFifo(sub);",
    to: "if (sub.spec.type === 'FIFO') await (sub.spec.maxBatchSize === -1 ? this.deliverFifo(sub) : this.deliverUnordered(sub));",
    tests: [MODEL],
  },
  {
    name: 'M15 the contract accepts unknown fields',
    file: 'src/contract/order-events.ts',
    from: 'if (extra.length > 0) throw',
    to: 'if (extra.length > 1000) throw',
    tests: ['test/unit/contract.test.ts'],
  },
  {
    name: 'M16 the JSONata expression reads the PutRawEvents path',
    file: 'infra/lib/expressions.ts',
    from: `  '"orderId": $events.Data.detail.orderId, ' +
  '"status": $events.Data.detail.status, ' +
  '"totalCents": $events.Data.detail.totalCents, ' +
  '"currency": $events.Data.detail.currency, ' +
  '"occurredAt": $events.Data.detail.occurredAt, ' +`,
    to: `  '"orderId": $events.Data.orderId, ' +
  '"status": $events.Data.status, ' +
  '"totalCents": $events.Data.totalCents, ' +
  '"currency": $events.Data.currency, ' +
  '"occurredAt": $events.Data.occurredAt, ' +`,
    tests: ['test/unit/expressions.test.ts'],
  },
  {
    name: 'M17 the publisher IAM action uses the eventsv2: prefix',
    file: 'infra/lib/orders-bus-stack.ts',
    from: "actions: ['events:PutEvents'],",
    to: "actions: ['eventsv2:PutEvents'],",
    tests: [STACK],
  },
];

const root = join(__dirname, '..');
const withDynamo = Boolean(process.env.AWS_ENDPOINT_URL_DYNAMODB);
const selected = mutants.filter((m) => !m.int || withDynamo);

const COMPILE_ERROR = /error TS\d+|TS\d{4,5}:/;

function run(args: string[]): { ok: boolean; output: string } {
  try {
    execFileSync('npx', args, { cwd: root, stdio: 'pipe', timeout: 600_000 });
    return { ok: true, output: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, output: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` };
  }
}

/** True if every listed test passes. Throws if a failure is a TypeScript error. */
function passes(m: Pick<Mutant, 'name' | 'tests' | 'int'>): boolean {
  const runs: string[][] = [];
  if (m.tests?.length) runs.push(['jest', '--silent', ...m.tests]);
  if (m.int?.length) runs.push(['jest', '-c', 'jest.integration.config.js', '--runInBand', '--silent', ...m.int]);
  for (const args of runs) {
    const { ok, output } = run(args);
    if (ok) continue;
    if (COMPILE_ERROR.test(output)) {
      throw new Error(`"${m.name}" failed to compile, so it proves nothing. Rewrite it.\n${output.slice(0, 2000)}`);
    }
    return false;
  }
  return true;
}

// A mutant only counts as killed if the same tests pass without it.
const all = {
  name: 'no mutant',
  tests: [...new Set(selected.flatMap((m) => m.tests ?? []))],
  int: [...new Set(selected.flatMap((m) => m.int ?? []))],
};
if (!passes(all)) throw new Error('The tests fail without any mutant. Fix that first (and run npm run bundle).');

let survived = 0;
for (const m of selected) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');
  if (original.split(m.from).length !== 2) throw new Error(`"${m.name}": the text to mutate must appear exactly once in ${m.file}`);
  writeFileSync(path, original.replace(m.from, () => m.to));
  let killed: boolean;
  try {
    killed = !passes(m);
  } finally {
    writeFileSync(path, original);
  }
  if (!killed) survived++;
  process.stdout.write(`${killed ? 'killed  ' : 'SURVIVED'}  ${m.name}\n`);
}
const skipped = mutants.length - selected.length;
process.stdout.write(
  `\n${selected.length - survived} of ${selected.length} mutants killed${skipped ? `, ${skipped} skipped (set AWS_ENDPOINT_URL_DYNAMODB)` : ''}\n`,
);
process.exit(survived === 0 ? 0 : 1);
