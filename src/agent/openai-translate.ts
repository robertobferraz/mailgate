import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { LlmRequest } from './llm-client';

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

const MAX_COMPLETION_TOKENS = 16000;

function textOf(
  content: string | Anthropic.ToolResultBlockParam['content'],
): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function toChatMessages(m: Anthropic.MessageParam): ChatMessage[] {
  if (typeof m.content === 'string')
    return [{ role: m.role, content: m.content }];
  if (m.role === 'assistant') {
    const text = m.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const calls = m.content
      .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
    ];
  }
  // user turn: tool results first (role:tool), then any text
  const out: ChatMessage[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result')
      out.push({
        role: 'tool',
        tool_call_id: b.tool_use_id,
        content: textOf(b.content),
      });
  }
  const text = m.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (text) out.push({ role: 'user', content: text });
  return out;
}

export function toChatRequest(
  req: LlmRequest,
  model: string,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  return {
    model,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    messages: [
      { role: 'system', content: req.system },
      ...req.messages.flatMap(toChatMessages),
    ],
    ...(req.tools.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              parameters: t.input_schema,
            },
          })),
          tool_choice: 'auto' as const,
          // the runner handles one tool per turn (D010)
          parallel_tool_calls: false,
        }
      : {}),
  };
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {}; // the runner's Zod check turns this into an is_error tool_result
  }
}

const STOP: Record<string, Anthropic.Message['stop_reason']> = {
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export function fromChatCompletion(
  c: OpenAI.Chat.ChatCompletion,
): Anthropic.Message {
  const choice = c.choices[0];
  const msg = choice.message;
  const content: unknown[] = [];
  if (msg.content)
    content.push({ type: 'text', text: msg.content, citations: null });
  const first = msg.tool_calls?.find((t) => t.type === 'function');
  if (first && first.type === 'function')
    content.push({
      type: 'tool_use',
      id: first.id,
      name: first.function.name,
      input: parseArgs(first.function.arguments),
    });
  const stop_reason = msg.refusal
    ? 'refusal'
    : (STOP[choice.finish_reason] ?? 'end_turn');
  return {
    id: c.id,
    type: 'message',
    role: 'assistant',
    model: c.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: c.usage?.prompt_tokens ?? 0,
      output_tokens: c.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as unknown as Anthropic.Message;
}
