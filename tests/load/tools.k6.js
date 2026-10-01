// Latency test (handoff §16): each tool, 20 VUs, 2 minutes. Pass: p95 < 300 ms, p99 < 450 ms, no errors.
//   eval "$(npm run -s tokens)" && TARGET_URL=http://localhost:8787/mcp k6 run tests/load/tools.k6.js
// For the cloud, set TARGET_URL and get TOKEN_RECIPIENT / TOKEN_CAREGIVER from Cognito.
import http from 'k6/http';
import { check } from 'k6';

const URL = __ENV.TARGET_URL || 'http://localhost:8787/mcp';
const RECIPIENT = __ENV.TOKEN_RECIPIENT;
const CAREGIVER = __ENV.TOKEN_CAREGIVER;

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '2m',
  thresholds: {
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<300', 'p(99)<450'],
  },
};

// Read-mostly mix that doesn't change the demo data much; writes are idempotent (check-in upsert).
const CALLS = [
  { tool: 'care_circle_help', args: {}, token: null },
  { tool: 'get_status', args: {}, token: 'caregiver' },
  { tool: 'get_week_summary', args: { days: 7 }, token: 'caregiver' },
  { tool: 'get_todays_doses', args: { part_of_day: 'all' }, token: 'recipient' },
  { tool: 'check_in', args: { mood: 'good' }, token: 'recipient' },
  { tool: 'log_dose', args: { medication_name: 'aspirin', status: 'taken' }, token: 'recipient' },
];

export default function () {
  const call = CALLS[Math.floor(Math.random() * CALLS.length)];
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
  if (call.token === 'recipient') headers.authorization = `Bearer ${RECIPIENT}`;
  if (call.token === 'caregiver') headers.authorization = `Bearer ${CAREGIVER}`;
  const res = http.post(URL, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: call.tool, arguments: call.args } }), {
    headers,
    tags: { tool: call.tool },
  });
  check(res, { 'status 200': (r) => r.status === 200, 'has result': (r) => r.json('result') !== undefined });
}
