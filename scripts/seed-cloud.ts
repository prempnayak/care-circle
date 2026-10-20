/**
 * Seed the demo circle (14 days of history) into the deployed table for REAL Cognito users,
 * after Margaret, Sarah and Tom have each signed up once (e.g. by linking in the simulator).
 *
 *   TABLE_NAME=CareCircle KMS_KEY_ID=<DataKey ARN> COGNITO_USER_POOL_ID=<id> AWS_REGION=us-east-1 \
 *   npm run seed:cloud -- --margaret m@example.com --sarah s@example.com --tom t@example.com
 *
 * Writes only the demo circle's items (circle id `cdemomargaret`) and those three users' profiles.
 * Each user must not already belong to another circle.
 */
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CareStore, KmsCrypto, createDb, seedDemo, systemClock, type DemoPerson } from '@care-circle/core';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`Missing --${name} <email>`);
  return v;
}

const table = process.env.TABLE_NAME ?? 'CareCircle';
const keyId = process.env.KMS_KEY_ID;
const poolId = process.env.COGNITO_USER_POOL_ID;
if (!keyId || !poolId) throw new Error('Set KMS_KEY_ID and COGNITO_USER_POOL_ID (from the CDK outputs).');
if (process.env.DDB_ENDPOINT) throw new Error('This script is for the deployed table; unset DDB_ENDPOINT (use npm run seed:demo locally).');

const cognito = new CognitoIdentityProviderClient({});
async function person(email: string, fallbackName: string): Promise<DemoPerson> {
  const res = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, Filter: `email = "${email.replace(/"/g, '')}"`, Limit: 1 }));
  const user = res.Users?.[0];
  if (!user) throw new Error(`No Cognito user with email ${email}. Sign up first (link the account in the simulator).`);
  const attr = (n: string) => user.Attributes?.find((a) => a.Name === n)?.Value;
  return { sub: attr('sub')!, firstName: attr('given_name') ?? fallbackName, email };
}

const people = {
  margaret: { ...(await person(arg('margaret'), 'Margaret')), firstName: 'Margaret' },
  sarah: await person(arg('sarah'), 'Sarah'),
  tom: await person(arg('tom'), 'Tom'),
};
const store = new CareStore(createDb({ table, region: process.env.AWS_REGION }));
for (const p of Object.values(people)) {
  const { membership } = await store.getIdentity(p.sub);
  if (membership && membership.circleId !== 'cdemomargaret') {
    throw new Error(`${p.email} is already in circle ${membership.circleId}. Use fresh sign-ups (or remove them on the dashboard first).`);
  }
}
const { circleId } = await seedDemo(store, systemClock, new KmsCrypto(keyId), people);
console.log(`Seeded circle ${circleId} for ${Object.values(people).map((p) => p.firstName).join(', ')}.`);
