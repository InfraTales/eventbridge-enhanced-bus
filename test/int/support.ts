import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';

/** DynamoDB Local, found through the standard AWS_ENDPOINT_URL_DYNAMODB variable. */
export function localClient(): DynamoDBClient {
  if (!process.env.AWS_ENDPOINT_URL_DYNAMODB) {
    throw new Error('Set AWS_ENDPOINT_URL_DYNAMODB (for example http://localhost:8025) to run integration tests');
  }
  return new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
}

/** Creates the same key schema as the stack's LedgerTable. */
export async function createLedgerTable(client: DynamoDBClient): Promise<{ name: string; drop: () => Promise<void> }> {
  const name = `ledger-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [{ AttributeName: 'orderId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  return { name, drop: async () => void (await client.send(new DeleteTableCommand({ TableName: name }))) };
}
