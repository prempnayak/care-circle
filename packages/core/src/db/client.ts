import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface Db {
  doc: DynamoDBDocumentClient;
  raw: DynamoDBClient;
  table: string;
}

export function createDb(opts: { table: string; endpoint?: string; region?: string }): Db {
  const raw = new DynamoDBClient({
    region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1',
    ...(opts.endpoint
      ? {
          endpoint: opts.endpoint,
          // DynamoDB Local accepts any credentials.
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {}),
  });
  const doc = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
  return { doc, raw, table: opts.table };
}

/** Table and index definition, shared by the local reset script and tests (CDK mirrors it in infra/). */
export function tableDefinition(table: string): CreateTableCommandInput {
  return {
    TableName: table,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
      { AttributeName: 'GSI1PK', AttributeType: 'S' },
      { AttributeName: 'GSI1SK', AttributeType: 'S' },
      { AttributeName: 'GSI2PK', AttributeType: 'S' },
      { AttributeName: 'GSI2SK', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'GSI1',
        KeySchema: [
          { AttributeName: 'GSI1PK', KeyType: 'HASH' },
          { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'GSI2',
        KeySchema: [
          { AttributeName: 'GSI2PK', KeyType: 'HASH' },
          { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  };
}

export async function tableExists(db: Db): Promise<boolean> {
  try {
    await db.raw.send(new DescribeTableCommand({ TableName: db.table }));
    return true;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return false;
    throw err;
  }
}

export async function createTable(db: Db): Promise<void> {
  await db.raw.send(new CreateTableCommand(tableDefinition(db.table)));
  try {
    await db.raw.send(
      new UpdateTimeToLiveCommand({
        TableName: db.table,
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      }),
    );
  } catch {
    // Older DynamoDB Local builds don't support TTL; it only matters in the cloud.
  }
}

export async function dropTable(db: Db): Promise<void> {
  if (await tableExists(db)) await db.raw.send(new DeleteTableCommand({ TableName: db.table }));
}

export async function resetTable(db: Db): Promise<void> {
  await dropTable(db);
  await createTable(db);
}
