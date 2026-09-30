import { serve } from '@hono/node-server';
import { createDb, createServices, createTable, loadConfig, seedDemo, seedFresh, tableExists } from '@care-circle/core';
import { startLocalWorkers } from '@care-circle/workers';
import { createApp } from './app';

const config = loadConfig();
const services = createServices(config);

if (config.DDB_ENDPOINT) {
  // Local mode: make sure the table exists (DynamoDB Local runs in memory).
  const db = createDb({ table: config.TABLE_NAME, endpoint: config.DDB_ENDPOINT });
  if (!(await tableExists(db))) {
    await createTable(db);
    const seed = process.env.SEED_ON_START;
    if (seed === 'demo') await seedDemo(services.store, services.clock, services.crypto);
    if (seed === 'fresh') await seedFresh(services.store);
    services.logger.info('local table created', { seeded: seed || 'none' });
  }
}

if (config.RUN_WORKERS) startLocalWorkers(services, config.WORKER_INTERVAL_SEC);

serve({ fetch: createApp(services).fetch, port: config.PORT, hostname: '0.0.0.0' }, () => {
  services.logger.info('care-circle api listening', { url: config.PUBLIC_BASE_URL, auth: config.AUTH_MODE, dev: config.DEV_ENDPOINTS });
});
