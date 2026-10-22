/**
 * Reset the demo circle in the DEPLOYED table: delete every item in its partition (check-ins, doses,
 * messages, alerts, audit, members, medicines), then seed it again with 14 days of history.
 * Cognito accounts and simulator links are untouched, so nobody has to sign in again.
 *
 *   TABLE_NAME=CareCircle KMS_KEY_ID=<DataKey ARN> COGNITO_USER_POOL_ID=<id> AWS_REGION=us-east-1 \
 *   npm run reset:cloud -- --yes --margaret m@example.com --sarah s@example.com --tom t@example.com
 *
 * Only the partition CIRCLE#cdemomargaret is touched. Without --yes it only counts what it would delete.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand, type BatchWriteCommandOutput } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME ?? 'CareCircle';
const PK = 'CIRCLE#cdemomargaret';
if (process.env.DDB_ENDPOINT) throw new Error('This script is for the deployed table; unset DDB_ENDPOINT (use npm run reset:local locally).');

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function keys(): Promise<{ PK: string; SK: string }[]> {
  const out: { PK: string; SK: string }[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await db.send(
      new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': PK }, ProjectionExpression: 'PK, SK', ExclusiveStartKey: start }),
    );
    out.push(...((r.Items ?? []) as { PK: string; SK: string }[]));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

const items = await keys();
const kinds: Record<string, number> = {};
for (const i of items) kinds[i.SK.split('#')[0]!] = (kinds[i.SK.split('#')[0]!] ?? 0) + 1;
console.log(`${PK}: ${items.length} items ${JSON.stringify(kinds)}`);

if (!process.argv.includes('--yes')) {
  console.log('Dry run. Add --yes to delete these items and reseed the demo circle.');
  process.exit(0);
}

for (let i = 0; i < items.length; i += 25) {
  let pending: Record<string, unknown> | undefined = { [TABLE]: items.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
  for (let attempt = 0; pending && attempt < 8; attempt++) {
    const r: BatchWriteCommandOutput = await db.send(new BatchWriteCommand({ RequestItems: pending as never }));
    pending = r.UnprocessedItems && Object.keys(r.UnprocessedItems).length > 0 ? r.UnprocessedItems : undefined;
    if (pending) await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
  }
  if (pending) throw new Error('DynamoDB kept throttling the delete; run the script again.');
}
console.log(`Deleted ${items.length} items. Left in partition: ${(await keys()).length}. Reseeding…`);

// Same arguments (--margaret/--sarah/--tom); seed-cloud reads them from argv.
await import('./seed-cloud');
