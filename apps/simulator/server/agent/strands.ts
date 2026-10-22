/**
 * Strands agent (SIM_AGENT=strands): an AWS Strands Agents SDK agent that plays Alexa+. It reads the
 * Agent Skill as its system prompt, sees Care Circle's tools from the MCP server's tools/list, and
 * calls them through the simulator's MCP client with the persona's own token, so account linking,
 * the trace panel and the Echo Show card work exactly as with the other agents.
 *
 * The model is a setting, not code:
 *   SIM_MODEL_PROVIDER=lmstudio  SIM_MODEL_ID=qwen/qwen3-8b        (local, OpenAI-compatible server)
 *   SIM_MODEL_PROVIDER=bedrock   SIM_MODEL_ID=us.anthropic.claude-haiku-5-5
 *
 * Safety net: injury or self-harm wording goes straight to check_in (Care Circle's deterministic crisis
 * matcher, the same one the server runs), so the 911/988 redirect and the family email never depend on
 * the model choosing a tool. Small local models often answer such phrases themselves instead.
 *
 * One tool call per turn, and Alexa says Care Circle's own reply as-is: the speech is already
 * written to the voice rules (two sentences, "logged" not "took", no IDs), and skipping a second
 * model call to rephrase it halves the turn time.
 */
import { Agent as StrandsAgent, BedrockModel, FunctionTool, type JSONSchema, type MessageData, type Model } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { Tool } from '@modelcontextprotocol/client';
import { matchCrisis } from '@care-circle/core';
import { NeedsLinking } from '../mcp';
import type { ToolCallRecord } from '../types';
import { loadSkill } from './bedrock';
import { clean as stripInvocation } from './router';
import type { Agent, AgentContext, AgentReply } from './types';

const MAX_HISTORY = 12;

export interface ModelChoice {
  provider: 'lmstudio' | 'bedrock';
  modelId: string;
  baseUrl?: string;
  region?: string;
}

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelChoice {
  const provider = env.SIM_MODEL_PROVIDER === 'bedrock' ? 'bedrock' : 'lmstudio';
  if (provider === 'bedrock') {
    const modelId = env.SIM_MODEL_ID || env.BEDROCK_MODEL_ID;
    if (!modelId) throw new Error('Set SIM_MODEL_ID (or BEDROCK_MODEL_ID) for SIM_MODEL_PROVIDER=bedrock.');
    return { provider, modelId, region: env.AWS_REGION };
  }
  return { provider, modelId: env.SIM_MODEL_ID || 'qwen/qwen3-8b', baseUrl: env.LMSTUDIO_URL || 'http://localhost:1234/v1' };
}

export function describeModel(m: ModelChoice): string {
  return m.provider === 'bedrock' ? `${m.modelId} on Amazon Bedrock` : `${m.modelId} via LM Studio`;
}

function makeModel(m: ModelChoice): Model {
  if (m.provider === 'bedrock') return new BedrockModel({ modelId: m.modelId, temperature: 0, maxTokens: 400, ...(m.region ? { region: m.region } : {}) });
  // LM Studio speaks the OpenAI Chat Completions API; the key is ignored but the client wants one.
  return new OpenAIModel({ api: 'chat', modelId: m.modelId, apiKey: 'lm-studio', clientConfig: { baseURL: m.baseUrl }, temperature: 0, maxTokens: 400 });
}

/** check_in arguments for crisis wording, or null. The note is her own words, bounded like any note. */
export function crisisCheckIn(utterance: string): { name: 'check_in'; args: { note: string } } | null {
  const words = stripInvocation(utterance);
  return matchCrisis(words).category ? { name: 'check_in', args: { note: words.slice(0, 140) } } : null;
}

/** Model output can carry Qwen-style <think> blocks; Alexa never says them. */
function clean(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export class StrandsAgentImpl implements Agent {
  readonly name = 'strands' as const;
  private readonly skill = loadSkill();
  private readonly model: Model;

  constructor(readonly choice: ModelChoice = modelFromEnv()) {
    this.model = makeModel(choice);
  }

  private systemPrompt(now: Date): string {
    const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const lines = [
      this.skill,
      `You are Alexa. Today is ${today}.`,
      'When the request matches a Care Circle tool, call exactly one tool. Otherwise answer in plain speech, at most two sentences.',
      'A check-in is any way of saying they are up, awake or out of bed, or how they slept or feel this morning, however casual: ' +
        '"good morning", "morning! slept like a log", "up and at \'em", "rough night but I\'m up", "out of bed, feeling wobbly", "check in". ' +
        'Call check_in for every one of these; put how they feel in `mood` (good, okay or not_great) and their words in `note`.',
      'Never say you told the family, logged, shared or checked anything in unless a tool did it in this turn.',
      'Never answer questions about check-ins, medicines, messages or the family from memory or earlier turns; call a tool every time. ' +
        '"Any messages for me?" or "anything from the family?" means get_status, which reads out messages waiting for her.',
      'Safety: if the person mentions a fall, an injury, bleeding, chest pain, trouble breathing, a stroke, or wanting to die or hurt themselves, ' +
        "ALWAYS call check_in with their exact words as `note`. Do not answer on your own: Care Circle's reply tells them to call 911 " +
        '(or call or text 988) first and lets their family know.',
      "Put the person's own words in `note` or `message` exactly as they said them, without the wake word.",
      'Questions about what Care Circle is or can do: call care_circle_help.',
      'After a read-back that ends with "say yes", a "yes" means: call the same tool again with the same arguments plus confirm: true.',
    ];
    // Qwen 3 thinks before answering unless told not to; tool choice doesn't need it and it costs seconds.
    if (this.choice.provider === 'lmstudio' && /qwen3/i.test(this.choice.modelId)) lines.push('/no_think');
    return lines.join('\n\n');
  }

  /** Strands tools that wrap Care Circle's MCP tools. `onCall` decides what running one does. */
  private tools(mcpTools: Tool[], onCall: (name: string, input: Record<string, unknown>) => Promise<string>): FunctionTool[] {
    return mcpTools.map(
      (t) =>
        new FunctionTool({
          name: t.name,
          description: t.description ?? t.name,
          inputSchema: t.inputSchema as JSONSchema,
          callback: (input) => onCall(t.name, (input ?? {}) as Record<string, unknown>),
        }),
    );
  }

  async routeOnly(utterance: string, toolsHint?: unknown) {
    const safety = crisisCheckIn(utterance);
    if (safety) return safety;
    let first: { name: string; args: Record<string, unknown> } | null = null;
    const agent: StrandsAgent = new StrandsAgent({
      model: this.model,
      systemPrompt: this.systemPrompt(new Date()),
      printer: false,
      toolExecutor: 'sequential',
      // Record the first tool the model picks, then stop: routing only, nothing is called.
      tools: this.tools((toolsHint as Tool[]) ?? [], async (name, args) => {
        first ??= { name, args };
        agent.cancel();
        return 'ok';
      }),
    });
    await agent.invoke(utterance);
    return first ?? { name: null, args: {} };
  }

  async respond(ctx: AgentContext, utterance: string): Promise<AgentReply> {
    const conn = await ctx.connect();
    const history = ctx.persona.history as MessageData[];
    const toolCalls: ToolCallRecord[] = [];
    let needsLinking = false;
    try {
      const safety = crisisCheckIn(utterance);
      if (safety) {
        ctx.trace.push({ at: new Date().toISOString(), kind: 'agent', label: 'strands: crisis wording → check_in (safety net, no model call)' });
        const result = await conn.call(safety.name, safety.args);
        remember(history, utterance, result.speech, result);
        return { reply: result.speech, toolCalls: [result] };
      }
      const agent: StrandsAgent = new StrandsAgent({
        model: this.model,
        systemPrompt: this.systemPrompt(ctx.now),
        messages: history.slice(-MAX_HISTORY),
        printer: false,
        toolExecutor: 'sequential',
        tools: this.tools(conn.tools, async (name, args) => {
          try {
            const result = await conn.call(name, args);
            toolCalls.push(result);
            // The model sees the speech plus the structured result (e.g. step: "confirm" before a "yes").
            return result.structuredContent ? `${result.speech}\n${JSON.stringify(result.structuredContent)}` : result.speech;
          } catch (err) {
            if (err instanceof NeedsLinking) needsLinking = true;
            throw err;
          } finally {
            agent.cancel(); // one tool per turn; Alexa speaks Care Circle's reply
          }
        }),
      });

      const started = performance.now();
      const result = await agent.invoke(utterance);
      ctx.trace.push({
        at: new Date().toISOString(),
        kind: 'agent',
        label: `strands: ${describeModel(this.choice)}${toolCalls[0] ? ` → ${toolCalls[0].name}` : ' → no tool'}`,
        ms: Math.round(performance.now() - started),
      });
      if (needsLinking) throw new NeedsLinking();

      const call = toolCalls[0];
      const reply = call ? call.speech : clean(result.lastMessage.content.map((c) => ('text' in c ? c.text : '')).join(' '));
      remember(history, utterance, reply, call);
      return { reply: reply || "Sorry, I didn't catch that. Try again?", toolCalls };
    } finally {
      await conn.close();
    }
  }
}

/** Keep a compact, valid conversation: user text, then (tool use, tool result,) assistant text. */
function remember(history: MessageData[], utterance: string, reply: string, call?: ToolCallRecord): void {
  history.push({ role: 'user', content: [{ text: utterance }] });
  if (call) {
    const toolUseId = `t${Date.now().toString(36)}`;
    history.push({ role: 'assistant', content: [{ toolUse: { name: call.name, toolUseId, input: call.args as never } }] });
    history.push({
      role: 'user',
      content: [{ toolResult: { toolUseId, status: call.isError ? 'error' : 'success', content: [{ text: call.speech }, ...(call.structuredContent ? [{ json: call.structuredContent as never }] : [])] } }],
    });
  }
  history.push({ role: 'assistant', content: [{ text: reply }] });
  while (history.length > MAX_HISTORY) history.shift();
  // Never start on a tool result or an assistant turn.
  while (history.length > 0 && (history[0]!.role !== 'user' || history[0]!.content.some((c) => 'toolResult' in c))) history.shift();
}
