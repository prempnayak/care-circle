/**
 * Tests that touch DynamoDB use DynamoDB Local. If it isn't reachable we try to start it
 * with `docker compose up -d dynamodb`, then fail with a clear message.
 */
import { execSync } from 'node:child_process';

const endpoint = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

export default async function setup(): Promise<void> {
  process.env.DDB_ENDPOINT = endpoint;
  if (await reachable()) return;
  try {
    execSync('docker compose up -d dynamodb', { stdio: 'ignore' });
  } catch {
    // fall through to the error below
  }
  for (let i = 0; i < 40; i++) {
    if (await reachable()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`DynamoDB Local isn't reachable at ${endpoint}. Start it with: docker compose up -d dynamodb`);
}
