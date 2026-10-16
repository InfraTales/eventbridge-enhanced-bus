/**
 * Ledger Lambda, the target of the ordered subscriber. Invoked with REQUEST_RESPONSE,
 * so EventBridge waits for this function to return and counts a thrown error as a
 * failed delivery. That's what keeps the order: the next events in the same group
 * wait until this batch succeeds.
 */
import { requireEnv } from '../config';
import { processDelivery, type ProcessSummary } from './process';
import { DynamoLedgerStore } from './store';

let store: DynamoLedgerStore | undefined;

export async function handler(payload: unknown): Promise<ProcessSummary> {
  store ??= new DynamoLedgerStore(requireEnv('LEDGER_TABLE'));
  const summary = await processDelivery(payload, store);
  console.log(JSON.stringify({ msg: 'ledger batch applied', ...summary }));
  return summary;
}
