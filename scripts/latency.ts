/**
 * Quick latency check without k6: calls each tool N times (sequentially and with concurrency)
 * and prints p50/p95/p99 per tool.   npm run test:latency   (needs the local stack running)
 */
import { devToken } from './mint-tokens';

const url = process.env.TARGET_URL ?? 'http://localhost:8787/mcp';
const N = Number(process.env.N ?? 100);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);

const recipient = await devToken('dev-margaret');
const caregiver = await devToken('dev-sarah');
const calls: [string, Record<string, unknown>, string | null][] = [
  ['care_circle_help', {}, null],
  ['get_status', {}, caregiver],
  ['get_week_summary', { days: 7 }, caregiver],
  ['get_todays_doses', { part_of_day: 'all' }, recipient],
  ['check_in', { mood: 'good' }, recipient],
  ['log_dose', { medication_name: 'aspirin', status: 'taken' }, recipient],
];

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;
let worstP95 = 0;
let worstP99 = 0;
console.log(`tool                 p50    p95    p99   (n=${N}, concurrency ${CONCURRENCY})`);
for (const [tool, args, token] of calls) {
  const times: number[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < N) {
        next++;
        const t0 = performance.now();
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
        });
        await res.text();
        if (res.status !== 200) throw new Error(`${tool}: HTTP ${res.status}`);
        times.push(performance.now() - t0);
      }
    }),
  );
  times.sort((a, b) => a - b);
  const [p50, p95, p99] = [pct(times, 50), pct(times, 95), pct(times, 99)];
  worstP95 = Math.max(worstP95, p95);
  worstP99 = Math.max(worstP99, p99);
  console.log(`${tool.padEnd(20)} ${p50.toFixed(0).padStart(4)}ms ${p95.toFixed(0).padStart(4)}ms ${p99.toFixed(0).padStart(4)}ms`);
}
const pass = worstP95 < 300 && worstP99 < 450;
console.log(`worst p95 ${worstP95.toFixed(0)} ms, worst p99 ${worstP99.toFixed(0)} ms → ${pass ? 'PASS' : 'FAIL'} (p95 < 300, p99 < 450)`);
process.exit(pass ? 0 : 1);
