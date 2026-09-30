/**
 * Local table setup. Default: create CareCircle (and its GSIs) if it's missing, seeding per SEED_ON_START.
 * `--drop`: drop and recreate it, then seed the demo circle (npm run reset:local).
 */
import { createDb, createServices, createTable, loadConfig, resetTable, seedDemo, seedFresh, tableExists } from '@care-circle/core';

const config = loadConfig();
if (!config.DDB_ENDPOINT) throw new Error('reset-local only runs against DynamoDB Local (set DDB_ENDPOINT).');
const db = createDb({ table: config.TABLE_NAME, endpoint: config.DDB_ENDPOINT });

for (let i = 0; i < 30; i++) {
  try {
    await tableExists(db);
    break;
  } catch {
    if (i === 29) throw new Error(`DynamoDB Local isn't reachable at ${config.DDB_ENDPOINT}. Try: docker compose up -d dynamodb`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const drop = process.argv.includes('--drop');
let seed = process.env.SEED_ON_START ?? '';
if (drop) {
  await resetTable(db);
  seed = seed || 'demo';
  console.log(`Recreated table ${config.TABLE_NAME}.`);
} else if (!(await tableExists(db))) {
  await createTable(db);
  console.log(`Created table ${config.TABLE_NAME}.`);
} else {
  console.log(`Table ${config.TABLE_NAME} already exists.`);
  seed = '';
}

if (seed) {
  const services = createServices(config);
  if (seed === 'fresh') await seedFresh(services.store);
  else await seedDemo(services.store, services.clock, services.crypto);
  console.log(`Seeded: ${seed}`);
}
