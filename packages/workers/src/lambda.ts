/**
 * AWS Lambda entry points for the workers (wired up in infra/lib/workers-stack.ts).
 * EventBridge Scheduler invokes the materializer hourly and the sweep every 5 minutes;
 * SQS invokes the notifier with partial batch responses so one bad message doesn't retry the rest.
 */
import { alertMessageSchema, createServices, loadConfig, materializeAll, type Services } from '@care-circle/core';
import { handleAlert } from './notifier';
import { runSweep } from './sweep';

let services: Services | undefined;
const getServices = () => (services ??= createServices(loadConfig()));

export async function materializerHandler() {
  return materializeAll(getServices().store, getServices().clock);
}

export async function sweepHandler() {
  return runSweep(getServices());
}

interface SqsEvent {
  Records: { messageId: string; body: string }[];
}

export async function notifierHandler(event: SqsEvent) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await handleAlert(getServices(), alertMessageSchema.parse(JSON.parse(record.body)));
    } catch (err) {
      getServices().logger.warn('notifier record failed', { messageId: record.messageId, err });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
