import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Logger } from './logger';
import { alertMessageSchema, type AlertMessage } from './types';

/** The alert queue. Tools enqueue; the notifier consumes. */
export interface Queue {
  send(message: AlertMessage): Promise<void>;
}

export type AlertHandler = (message: AlertMessage) => Promise<void>;

/**
 * In-process queue for local mode. Delivery is asynchronous (like SQS), with up to 3 attempts,
 * after which the message goes to an in-memory dead-letter list.
 */
export class MemoryQueue implements Queue {
  private handler: AlertHandler | null = null;
  private pending = new Set<Promise<void>>();
  readonly deadLetters: AlertMessage[] = [];
  readonly sent: AlertMessage[] = [];

  constructor(
    private readonly logger?: Logger,
    private readonly maxAttempts = 3,
  ) {}

  subscribe(handler: AlertHandler): void {
    this.handler = handler;
  }

  async send(message: AlertMessage): Promise<void> {
    const parsed = alertMessageSchema.parse(message);
    this.sent.push(parsed);
    if (!this.handler) return;
    const handler = this.handler;
    const run = (async () => {
      await new Promise((r) => setImmediate(r));
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          await handler(parsed);
          return;
        } catch (err) {
          this.logger?.warn('alert delivery failed', { type: parsed.type, attempt, err });
        }
      }
      this.deadLetters.push(parsed);
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  /** Wait until every delivery started so far has finished (tests and /dev/sweep). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

export class SqsQueue implements Queue {
  constructor(
    private readonly queueUrl: string,
    private readonly client = new SQSClient({}),
  ) {}

  async send(message: AlertMessage): Promise<void> {
    const parsed = alertMessageSchema.parse(message);
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(parsed) }));
  }
}
