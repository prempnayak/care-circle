import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Key } from 'aws-cdk-lib/aws-kms';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import { EmailIdentity, Identity } from 'aws-cdk-lib/aws-ses';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { nodeFunction, repoRoot } from './bundling';

export interface WorkersStackProps extends StackProps {
  table: Table;
  key: Key;
  mailFrom: string;
  dashboardUrl: string;
}

/**
 * Materializer (hourly) and sweep (every 5 minutes) on EventBridge Scheduler; an SQS alert queue with
 * a DLQ after 3 attempts; the notifier Lambda; and the SES sender identity (verifying it is a human task,
 * and in the SES sandbox every recipient must be verified too).
 */
export class WorkersStack extends Stack {
  readonly queue: Queue;

  constructor(scope: Construct, id: string, props: WorkersStackProps) {
    super(scope, id, props);
    const dlq = new Queue(this, 'AlertsDlq', { retentionPeriod: Duration.days(14), encryption: QueueEncryption.SQS_MANAGED });
    this.queue = new Queue(this, 'Alerts', {
      visibilityTimeout: Duration.seconds(60),
      encryption: QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    new EmailIdentity(this, 'Sender', { identity: Identity.email(props.mailFrom) });

    const environment = {
      TABLE_NAME: props.table.tableName,
      QUEUE_MODE: 'sqs',
      QUEUE_URL: this.queue.queueUrl,
      MAIL_MODE: 'ses',
      MAIL_FROM: props.mailFrom,
      CRYPTO_MODE: 'kms',
      KMS_KEY_ID: props.key.keyArn,
      DASHBOARD_URL: props.dashboardUrl,
      NODE_OPTIONS: '--enable-source-maps',
    };
    const entry = `${repoRoot}packages/workers/src/lambda.ts`;

    const materializer = nodeFunction(this, 'Materializer', { entry, handler: 'materializerHandler', environment, timeout: Duration.minutes(5) });
    const sweep = nodeFunction(this, 'Sweep', { entry, handler: 'sweepHandler', environment, timeout: Duration.minutes(2) });
    const notifier = nodeFunction(this, 'Notifier', { entry, handler: 'notifierHandler', environment });

    // Least privilege per function.
    props.table.grantReadWriteData(materializer);
    props.table.grantReadWriteData(sweep);
    this.queue.grantSendMessages(sweep);
    props.table.grantReadWriteData(notifier);
    props.key.grantDecrypt(notifier);
    notifier.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
      }),
    );
    notifier.addEventSource(new SqsEventSource(this.queue, { batchSize: 5, reportBatchItemFailures: true }));

    new Schedule(this, 'MaterializeHourly', {
      schedule: ScheduleExpression.rate(Duration.hours(1)),
      target: new LambdaInvoke(materializer),
      description: 'Create check-in and dose items for today and tomorrow',
    });
    new Schedule(this, 'SweepEvery5Min', {
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(sweep),
      description: 'Flag overdue check-ins and doses and queue alerts',
    });
  }
}
