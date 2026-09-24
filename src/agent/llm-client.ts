import type Anthropic from '@anthropic-ai/sdk';

export interface LlmRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  signal?: AbortSignal;
}

export interface LlmClient {
  createMessage(req: LlmRequest): Promise<Anthropic.Message>;
}

export const LLM_CLIENT = Symbol('LLM_CLIENT');
export const ANTHROPIC_SDK = Symbol('ANTHROPIC_SDK');
