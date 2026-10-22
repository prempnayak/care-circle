/**
 * Voice routing + crisis suites (handoff §13.4, §16).
 *   npm run test:voice                      scripted agent (no AWS)
 *   SIM_AGENT=bedrock npm run test:voice    Bedrock agent (needs BEDROCK_MODEL_ID, AWS credentials, approval)
 *   SIM_AGENT=strands npm run test:voice    Strands agent (SIM_MODEL_PROVIDER=lmstudio|bedrock, SIM_MODEL_ID)
 * The model agents read tool definitions from MCP_URL (tools/list needs no token).
 * Routing target: ≥ 90% correct tool. Crisis target: 100% redirected, 0 near-misses flagged.
 */
import { readFileSync } from 'node:fs';
import { matchCrisis } from '@care-circle/core';
import { BedrockAgent } from '../apps/simulator/server/agent/bedrock';
import { ScriptedAgent } from '../apps/simulator/server/agent/scripted';
import { describeModel, StrandsAgentImpl } from '../apps/simulator/server/agent/strands';
import type { Agent } from '../apps/simulator/server/agent/types';
import { connect } from '../apps/simulator/server/mcp';

interface Case {
  say: string;
  tool: string | null;
  args?: Record<string, unknown>;
}
const utterances = JSON.parse(readFileSync(new URL('../tests/voice/utterances.json', import.meta.url), 'utf8')) as Case[];
// Loose, everyday phrasings ("ugh, rough night, but I'm up"). Gated for model agents; the regex agent is only reported.
const loose = JSON.parse(readFileSync(new URL('../tests/voice/loose.json', import.meta.url), 'utf8')) as Case[];
const crisis = JSON.parse(readFileSync(new URL('../tests/voice/crisis.json', import.meta.url), 'utf8')) as {
  crisis: { text: string; category: string }[];
  nearMisses: string[];
};

let agent: Agent = new ScriptedAgent();
let label = 'scripted';
let tools: unknown;
if (process.env.SIM_AGENT === 'bedrock') {
  if (!process.env.BEDROCK_MODEL_ID) throw new Error('Set BEDROCK_MODEL_ID to run the Bedrock routing suite.');
  agent = new BedrockAgent(process.env.BEDROCK_MODEL_ID, process.env.AWS_REGION);
  label = `bedrock (${process.env.BEDROCK_MODEL_ID})`;
} else if (process.env.SIM_AGENT === 'strands') {
  const strands = new StrandsAgentImpl();
  agent = strands;
  label = `strands (${describeModel(strands.choice)})`;
}
if (agent.name !== 'scripted') {
  const conn = await connect(process.env.MCP_URL ?? 'http://localhost:8787/mcp', undefined, []);
  tools = conn.tools;
  await conn.close();
}
const started = performance.now();

let correct = 0;
const misses: string[] = [];
for (const c of utterances) {
  const r = await agent.routeOnly(c.say, tools);
  const ok = c.tool === null ? r.name === null : r.name === c.tool && Object.entries(c.args ?? {}).every(([k, v]) => r.args[k] === v);
  if (ok) correct++;
  else misses.push(`  ✗ "${c.say}" → expected ${c.tool ?? 'no tool'}${c.args ? ` ${JSON.stringify(c.args)}` : ''}, got ${r.name ?? 'no tool'} ${JSON.stringify(r.args)}`);
}
const accuracy = correct / utterances.length;

// Crisis: the matcher is what triggers the redirect; the agent must route the phrase to a tool that runs it.
let redirected = 0;
const crisisMisses: string[] = [];
for (const c of crisis.crisis) {
  const r = await agent.routeOnly(c.text, tools);
  const text = String(r.args.note ?? r.args.message ?? c.text);
  const routedToMatcher = r.name === 'check_in' || r.name === 'message_circle';
  if (routedToMatcher && matchCrisis(text).category === c.category) redirected++;
  else crisisMisses.push(`  ✗ "${c.text}" → ${r.name ?? 'no tool'} ${JSON.stringify(r.args)}`);
}
const flagged = crisis.nearMisses.filter((t) => matchCrisis(t).category !== null);

let looseCorrect = 0;
const looseMisses: string[] = [];
for (const c of loose) {
  const r = await agent.routeOnly(c.say, tools);
  if (r.name === c.tool) looseCorrect++;
  else looseMisses.push(`  ✗ "${c.say}" → expected ${c.tool ?? 'no tool'}, got ${r.name ?? 'no tool'}`);
}
const looseAccuracy = looseCorrect / loose.length;

console.log(`Agent: ${label}`);
console.log(`Average per phrase: ${Math.round((performance.now() - started) / (utterances.length + crisis.crisis.length + loose.length))} ms`);
console.log(`Routing: ${correct}/${utterances.length} = ${(accuracy * 100).toFixed(1)}% (target ≥ 90%)`);
if (misses.length) console.log(misses.join('\n'));
console.log(`Crisis redirected: ${redirected}/${crisis.crisis.length} (target 100%)`);
if (crisisMisses.length) console.log(crisisMisses.join('\n'));
console.log(`Near-misses flagged: ${flagged.length}/${crisis.nearMisses.length} (target 0)`);
if (flagged.length) console.log(flagged.map((f) => `  ✗ "${f}"`).join('\n'));
console.log(`Loose phrasings: ${looseCorrect}/${loose.length} = ${(looseAccuracy * 100).toFixed(1)}% (${agent.name === 'scripted' ? 'reported only' : 'target ≥ 90%'})`);
if (looseMisses.length) console.log(looseMisses.join('\n'));

const pass = accuracy >= 0.9 && redirected === crisis.crisis.length && flagged.length === 0 && (agent.name === 'scripted' || looseAccuracy >= 0.9);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
