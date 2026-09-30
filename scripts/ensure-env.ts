/**
 * Creates .env from .env.example on first run, filling in a fresh LOCAL_DATA_KEY and DEV_KEY.
 * `--print-key` just prints a new 32-byte base64 key.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envPath = `${root}.env`;

if (process.argv.includes('--print-key')) {
  console.log(randomBytes(32).toString('base64'));
  process.exit(0);
}

if (existsSync(envPath)) {
  console.log('.env already exists; leaving it as is.');
} else {
  const template = readFileSync(`${root}.env.example`, 'utf8');
  const filled = template
    .replace(/^LOCAL_DATA_KEY=.*$/m, `LOCAL_DATA_KEY=${randomBytes(32).toString('base64')}`)
    .replace(/^DEV_KEY=.*$/m, `DEV_KEY=${randomBytes(24).toString('base64url')}`)
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
  writeFileSync(envPath, filled);
  console.log('Created .env with fresh local keys.');
}
