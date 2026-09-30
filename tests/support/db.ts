import { CareStore, createDb, createTable, dropTable, randomId } from '@care-circle/core';

/** A fresh table in DynamoDB Local for one test file. */
export async function freshStore(): Promise<{ store: CareStore; cleanup: () => Promise<void> }> {
  const db = createDb({ table: `CareCircleTest_${randomId(8)}`, endpoint: process.env.DDB_ENDPOINT ?? 'http://localhost:8000' });
  await createTable(db);
  return { store: new CareStore(db), cleanup: () => dropTable(db) };
}
