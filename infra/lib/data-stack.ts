import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Key } from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

/** One table (on demand, PITR, TTL `expiresAt`), GSI1 (user → circles), GSI2 (open deadlines), and a KMS CMK. */
export class DataStack extends Stack {
  readonly table: Table;
  readonly key: Key;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.key = new Key(this, 'DataKey', {
      description: 'Care Circle: DynamoDB encryption and field-level encryption of notes and messages',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.table = new Table(this, 'Table', {
      tableName: 'CareCircle',
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      // Hackathon: `cdk destroy` should clean up. Use RETAIN for real customer data.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'DataKeyArn', { value: this.key.keyArn });
  }
}
