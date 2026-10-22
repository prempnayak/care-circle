import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createSimulatorApp } from './index';

const port = Number(process.env.SIM_AGENT_PORT ?? 8790);
const app = createSimulatorApp({
  mcpUrl: process.env.MCP_URL ?? 'http://localhost:8787/mcp',
  agentPort: port,
  publicUrl: process.env.SIM_AGENT_PUBLIC_URL,
  uiOrigin: (process.env.SIMULATOR_URL ?? 'http://localhost:5174').replace(/\/$/, ''),
  agentMode: process.env.SIM_AGENT === 'bedrock' ? 'bedrock' : process.env.SIM_AGENT === 'strands' ? 'strands' : 'scripted',
  bedrockModelId: process.env.BEDROCK_MODEL_ID || undefined,
  region: process.env.AWS_REGION,
  devKey: process.env.DEV_KEY,
  devEndpoints: process.env.DEV_ENDPOINTS === 'true',
  tokenFile: process.env.SIM_TOKEN_FILE ?? fileURLToPath(new URL('../.tokens.json', import.meta.url)),
  log: (m) => console.log(`[simulator] ${m}`),
});

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`simulator agent listening on http://localhost:${port}`));
