import { randomBytes } from 'node:crypto';
import {
  AdjustableClock,
  LocalCrypto,
  MemoryMailer,
  MemoryQueue,
  createLogger,
  createServices,
  loadConfig,
  silentLogger,
  type Services,
} from '@care-circle/core';
import { freshStore } from './db';

export interface TestServices extends Services {
  queue: MemoryQueue;
  mailer: MemoryMailer;
  adjustableClock: AdjustableClock;
  cleanup: () => Promise<void>;
}

/** Real DynamoDB Local table, in-memory queue and mailer, a movable clock. */
export async function testServices(startAt = '2026-10-06T12:35:00Z', env: Record<string, string> = {}): Promise<TestServices> {
  const { store, cleanup } = await freshStore();
  const clock = new AdjustableClock();
  clock.set(new Date(startAt));
  const config = loadConfig({
    LOCAL_DATA_KEY: randomBytes(32).toString('base64'),
    DEV_ENDPOINTS: 'true',
    DEV_KEY: 'test-dev-key-0123456789',
    MAIL_MODE: 'memory',
    ...env,
  } as NodeJS.ProcessEnv);
  const queue = new MemoryQueue(silentLogger);
  const mailer = new MemoryMailer();
  const services = createServices(config, {
    store,
    clock,
    adjustableClock: clock,
    queue,
    mailer,
    crypto: new LocalCrypto(config.LOCAL_DATA_KEY!),
    logger: process.env.TEST_LOG ? createLogger({ test: true }, (l) => console.error(l), 'debug') : silentLogger,
  });
  return { ...services, queue, mailer, adjustableClock: clock, cleanup };
}
