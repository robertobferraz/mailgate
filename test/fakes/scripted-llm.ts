import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { LlmClient, LlmRequest } from '../../src/agent/llm-client';

export class ScriptedLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: Array<Anthropic.Message | Error> = []) {}

  push(...steps: Array<Anthropic.Message | Error>): void {
    this.script.push(...steps);
  }

  createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next)
      return Promise.reject(new Error('ScriptedLlmClient: script exhausted'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

function message(
  content: unknown[],
  stop_reason: Anthropic.Message['stop_reason'],
): Anthropic.Message {
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

export const toolUse = (
  name: string,
  input: Record<string, unknown>,
  id = `toolu_${randomUUID()}`,
) => message([{ type: 'tool_use', id, name, input }], 'tool_use');

export const endTurn = (text = 'Pronto.') =>
  message([{ type: 'text', text, citations: null }], 'end_turn');

export const stopWith = (reason: Anthropic.Message['stop_reason']) =>
  message([{ type: 'text', text: '', citations: null }], reason);
