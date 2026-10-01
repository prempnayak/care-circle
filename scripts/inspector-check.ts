/**
 * MCP Inspector CLI checks against a running server (npm run test:inspector; default http://localhost:8787/mcp).
 * Uses the official Inspector so the result doesn't depend on our own client code.
 */
import { spawnSync } from 'node:child_process';

const url = process.env.MCP_URL ?? 'http://localhost:8787/mcp';
const INSPECTOR = '@modelcontextprotocol/inspector@2.8.0';

function inspector(args: string[]) {
  const r = spawnSync('npx', ['-y', INSPECTOR, '--cli', url, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const checks: [string, () => boolean][] = [
  [
    'tools/list returns the 9 tools with portable schemas (--strict)',
    () => {
      const r = inspector(['--method', 'tools/list', '--strict']);
      const names = (JSON.parse(r.out) as { tools: { name: string }[] }).tools.map((t) => t.name);
      return r.code === 0 && names.length === 9;
    },
  ],
  [
    'care_circle_help works without a token',
    () => {
      const r = inspector(['--method', 'tools/call', '--tool-name', 'care_circle_help']);
      return r.code === 0 && r.out.includes('call 911');
    },
  ],
  [
    'get_status and get_todays_doses carry the MCP App card',
    () => {
      const r = inspector(['--method', 'tools/list', '--app-info']);
      const apps = r.out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { toolName: string; hasApp: boolean; resourceUri?: string })
        .filter((a) => a.hasApp);
      return apps.map((a) => a.toolName).sort().join(',') === 'get_status,get_todays_doses' && apps.every((a) => a.resourceUri === 'ui://care-circle/today');
    },
  ],
  [
    'resources/read serves the card as text/html;profile=mcp-app',
    () => {
      const r = inspector(['--method', 'resources/read', '--uri', 'ui://care-circle/today']);
      return r.code === 0 && r.out.includes('text/html;profile=mcp-app');
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  let ok: boolean;
  try {
    ok = check();
  } catch {
    ok = false;
  }
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
process.exit(failed ? 1 : 0);
