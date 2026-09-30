/** Standalone local worker loop (normally the API runs these in-process with RUN_WORKERS=true). */
import { createServices, loadConfig } from '@care-circle/core';
import { startLocalWorkers } from './runner';

const services = createServices(loadConfig());
startLocalWorkers(services, services.config.WORKER_INTERVAL_SEC);
services.logger.info('workers running', { intervalSec: services.config.WORKER_INTERVAL_SEC });
