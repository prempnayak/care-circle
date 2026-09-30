export interface TraceEntry {
  at: string;
  kind: 'mcp' | 'oauth' | 'agent' | 'dev';
  label: string;
  status?: number;
  ms?: number;
  detail?: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  status: number;
  isError: boolean;
  speech: string;
  structuredContent?: Record<string, unknown>;
  cardUri?: string;
}

export interface PendingAction {
  name: string;
  args: Record<string, unknown>;
}

export interface PersonaState {
  id: string;
  tokens?: Tokens;
  pending?: PendingAction;
  /** Bedrock conversation history (Alexa manages context from conversation history). */
  history: unknown[];
}

export interface TurnResult {
  reply: string;
  toolCalls: ToolCallRecord[];
  card?: { toolName: string; structuredContent: Record<string, unknown>; resourceUri: string; toolResult: unknown };
  needsLinking?: { authorizeUrl: string; resource: string; issuer: string };
  trace: TraceEntry[];
}
