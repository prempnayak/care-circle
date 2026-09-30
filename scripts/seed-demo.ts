/** npm run seed:demo | seed:fresh — reset the local table and load demo data. */
import { createDb, createServices, loadConfig, resetTable, seedDemo, seedFresh } from '@care-circle/core';

const which = process.argv[2] === 'fresh' ? 'fresh' : 'demo';
const config = loadConfig();
if (!config.DDB_ENDPOINT) throw new Error('Seeding only runs against DynamoDB Local (set DDB_ENDPOINT).');
await resetTable(createDb({ table: config.TABLE_NAME, endpoint: config.DDB_ENDPOINT }));
const services = createServices(config);
if (which === 'fresh') await seedFresh(services.store);
else await seedDemo(services.store, services.clock, services.crypto);
console.log(`Seeded ${which} data into ${config.TABLE_NAME}.`);
