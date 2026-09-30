import { AdjustableClock, type Clock } from './clock';
import type { Config } from './config';
import { KmsCrypto, LocalCrypto, type Crypto } from './crypto';
import { createDb } from './db/client';
import { CareStore } from './db/store';
import { createLogger, type Logger } from './logger';
import { MemoryMailer, SesMailer, SmtpMailer, type Mailer } from './mailer';
import { MemoryQueue, SqsQueue, type Queue } from './queue';

/** Side effects behind interfaces, chosen by env vars. */
export interface Services {
  config: Config;
  clock: Clock;
  /** Present when the clock can be moved (dev endpoints on). */
  adjustableClock?: AdjustableClock;
  store: CareStore;
  queue: Queue;
  mailer: Mailer;
  crypto: Crypto;
  logger: Logger;
}

export function createServices(config: Config, overrides: Partial<Services> = {}): Services {
  const logger = overrides.logger ?? createLogger({ service: 'care-circle' });
  const adjustableClock = config.DEV_ENDPOINTS ? new AdjustableClock() : undefined;
  const clock = overrides.clock ?? adjustableClock ?? { now: () => new Date() };
  const store =
    overrides.store ?? new CareStore(createDb({ table: config.TABLE_NAME, endpoint: config.DDB_ENDPOINT, region: config.AWS_REGION }));

  let queue = overrides.queue;
  if (!queue) {
    if (config.QUEUE_MODE === 'sqs') {
      if (!config.QUEUE_URL) throw new Error('QUEUE_MODE=sqs needs QUEUE_URL');
      queue = new SqsQueue(config.QUEUE_URL);
    } else {
      queue = new MemoryQueue(logger);
    }
  }

  let mailer = overrides.mailer;
  if (!mailer) {
    if (config.MAIL_MODE === 'ses') mailer = new SesMailer(config.MAIL_FROM);
    else if (config.MAIL_MODE === 'memory') mailer = new MemoryMailer();
    else mailer = new SmtpMailer(config.SMTP_URL, config.MAIL_FROM);
  }

  let crypto = overrides.crypto;
  if (!crypto) {
    if (config.CRYPTO_MODE === 'kms') {
      if (!config.KMS_KEY_ID) throw new Error('CRYPTO_MODE=kms needs KMS_KEY_ID');
      crypto = new KmsCrypto(config.KMS_KEY_ID);
    } else {
      crypto = new LocalCrypto(config.LOCAL_DATA_KEY!);
    }
  }

  return { config, clock, adjustableClock: overrides.adjustableClock ?? adjustableClock, store, queue, mailer, crypto, logger };
}
