import type { Connection } from '../mcp';
import type { PersonaState, ToolCallRecord, TraceEntry } from '../types';

export interface AgentContext {
  persona: PersonaState;
  /** Opens an MCP connection with the persona's token (fresh per turn; the server is stateless). */
  connect: () => Promise<Connection>;
  trace: TraceEntry[];
  now: Date;
}

export interface AgentReply {
  reply: string;
  toolCalls: ToolCallRecord[];
}

export interface Agent {
  readonly name: 'scripted' | 'bedrock' | 'strands';
  respond(ctx: AgentContext, utterance: string): Promise<AgentReply>;
  /** The first tool the agent would call for an utterance, without calling it (voice routing suite). */
  routeOnly(utterance: string, toolsHint?: unknown): Promise<{ name: string | null; args: Record<string, unknown> }>;
}
