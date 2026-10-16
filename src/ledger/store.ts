/**
 * The order ledger: one item per order holding its latest state.
 *
 * The write is conditional: it applies only when the incoming version is newer than
 * the stored one. That makes the ledger safe against duplicates, retried batches and
 * replays (all of which deliver an event again), and against any event that arrives
 * after a newer one.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { OrderStatusChanged } from '../contract/order-events';

export type ApplyResult = 'applied' | 'stale';

export interface LedgerItem extends OrderStatusChanged {
  lastEventId: string;
  updatedAt: string;
}

export interface LedgerStore {
  apply(event: OrderStatusChanged): Promise<ApplyResult>;
}

export class DynamoLedgerStore implements LedgerStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.doc = DynamoDBDocumentClient.from(client);
  }

  async apply(event: OrderStatusChanged): Promise<ApplyResult> {
    const item: LedgerItem = { ...event, lastEventId: event.eventId, updatedAt: this.now().toISOString() };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(orderId) OR #version < :version',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':version': event.version },
        }),
      );
      return 'applied';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'stale';
      throw err;
    }
  }

  async get(orderId: string): Promise<LedgerItem | undefined> {
    const out = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { orderId }, ConsistentRead: true }));
    return out.Item as LedgerItem | undefined;
  }
}
