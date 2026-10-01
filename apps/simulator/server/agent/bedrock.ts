/**
 * Bedrock agent (SIM_AGENT=bedrock): the Converse API with tool use. The system prompt is the
 * Agent Skill (skills/care-circle/SKILL.md) plus "You are Alexa. Today is <date>."; tools come
 * from the MCP server's tools/list; each toolUse is executed through the MCP client with the
 * persona's bearer token. At most 4 tool calls per turn. AWS credentials stay server-side.
 */
import { readFileSync } from 'node:fs';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool as BedrockTool,
} from '@aws-sdk/client-bedrock-runtime';
import type { Tool } from '@modelcontextprotocol/client';
import type { Agent, AgentContext, AgentReply } from './types';

const MAX_TOOL_CALLS = 4;
const MAX_HISTORY = 12;

export function loadSkill(): string {
  const path = process.env.SKILL_PATH ?? new URL('../../../../skills/care-circle/SKILL.md', import.meta.url);
  return readFileSync(path, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
}

export function toBedrockTools(tools: Tool[]): BedrockTool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: { json: t.inputSchema as never },
    },
  }));
}

export class BedrockAgent implements Agent {
  readonly name = 'bedrock' as const;
  private readonly client: BedrockRuntimeClient;
  private readonly skill = loadSkill();

  constructor(
    private readonly modelId: string,
    region?: string,
  ) {
    this.client = new BedrockRuntimeClient(region ? { region } : {});
  }

  private system(now: Date) {
    const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return [
      {
        text: `${this.skill}\n\nYou are Alexa. Today is ${today}. Reply in plain speech, at most two sentences. When a Care Circle tool returns speech, say that speech as-is.`,
      },
    ];
  }

  async routeOnly(utterance: string, toolsHint?: unknown) {
    const tools = toBedrockTools((toolsHint as Tool[]) ?? []);
    const out = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: this.system(new Date()),
        messages: [{ role: 'user', content: [{ text: utterance }] }],
        toolConfig: { tools },
        inferenceConfig: { maxTokens: 300, temperature: 0 },
      }),
    );
    const use = out.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
    return use ? { name: use.name ?? null, args: (use.input as Record<string, unknown>) ?? {} } : { name: null, args: {} };
  }

  async respond(ctx: AgentContext, utterance: string): Promise<AgentReply> {
    const conn = await ctx.connect();
    const toolCalls: AgentReply['toolCalls'] = [];
    try {
      const history = ctx.persona.history as Message[];
      history.push({ role: 'user', content: [{ text: utterance }] });
      const tools = toBedrockTools(conn.tools);

      for (let step = 0; step <= MAX_TOOL_CALLS; step++) {
        const started = performance.now();
        const out = await this.client.send(
          new ConverseCommand({
            modelId: this.modelId,
            system: this.system(ctx.now),
            messages: history.slice(-MAX_HISTORY),
            toolConfig: { tools },
            inferenceConfig: { maxTokens: 400, temperature: 0.2 },
          }),
        );
        ctx.trace.push({
          at: new Date().toISOString(),
          kind: 'agent',
          label: `bedrock converse (${out.stopReason})`,
          ms: Math.round(performance.now() - started),
        });
        const message = out.output?.message;
        if (!message) break;
        history.push(message);
        const uses = (message.content ?? []).filter((c): c is ContentBlock.ToolUseMember => Boolean(c.toolUse));
        if (out.stopReason !== 'tool_use' || uses.length === 0) {
          const text = (message.content ?? []).map((c) => c.text ?? '').join(' ').trim();
          return { reply: text || (toolCalls.at(-1)?.speech ?? ''), toolCalls };
        }
        if (toolCalls.length >= MAX_TOOL_CALLS) break;
        const results: ContentBlock[] = [];
        for (const { toolUse } of uses.slice(0, MAX_TOOL_CALLS - toolCalls.length)) {
          const result = await conn.call(toolUse.name!, (toolUse.input as Record<string, unknown>) ?? {});
          toolCalls.push(result);
          results.push({
            toolResult: {
              toolUseId: toolUse.toolUseId!,
              content: [{ text: result.speech }, ...(result.structuredContent ? [{ json: result.structuredContent as never }] : [])],
              ...(result.isError ? { status: 'error' as const } : {}),
            },
          });
        }
        history.push({ role: 'user', content: results });
      }
      return { reply: toolCalls.at(-1)?.speech ?? "Sorry, I couldn't finish that. Try again in a minute.", toolCalls };
    } finally {
      // Keep history bounded and never end on a dangling tool-use turn.
      const history = ctx.persona.history as Message[];
      while (history.length > MAX_HISTORY) history.shift();
      while (history.length > 0 && history[0]!.content?.some((c) => c.toolResult)) history.shift();
      await conn.close();
    }
  }
}
