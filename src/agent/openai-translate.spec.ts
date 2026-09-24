import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { fromChatCompletion, toChatRequest } from './openai-translate';

const tool: Anthropic.Tool = {
  name: 'record_decision',
  description: 'grava',
  input_schema: {
    type: 'object',
    properties: { decision: { type: 'string' } },
  },
};

describe('toChatRequest', () => {
  it('maps system, tools, tool_use and tool_result', () => {
    const r = toChatRequest(
      {
        system: 'SYS',
        tools: [tool],
        messages: [
          { role: 'user', content: 'pedido' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'x', signature: 's' },
              { type: 'text', text: 'vou gravar' },
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'record_decision',
                input: { decision: 'APPROVED' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: '{"ok":true}',
              },
            ],
          },
        ] as Anthropic.MessageParam[],
      },
      'gpt-x',
    );
    expect(r.model).toBe('gpt-x');
    expect(r.parallel_tool_calls).toBe(false);
    expect(r.tool_choice).toBe('auto');
    expect(r.max_completion_tokens).toBe(16000);
    expect(r.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'record_decision',
          description: 'grava',
          parameters: tool.input_schema,
        },
      },
    ]);
    expect(r.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'pedido' },
      {
        role: 'assistant',
        content: 'vou gravar',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'record_decision',
              arguments: '{"decision":"APPROVED"}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ]);
  });

  it('sends null content for an assistant turn with only tool calls', () => {
    const r = toChatRequest(
      {
        system: 'S',
        tools: [],
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'c', name: 'n', input: {} }],
          },
        ] as Anthropic.MessageParam[],
      },
      'm',
    );
    expect(r.messages[1]).toMatchObject({ role: 'assistant', content: null });
  });
});

const completion = (
  message: Partial<OpenAI.Chat.ChatCompletionMessage>,
  finish_reason: OpenAI.Chat.ChatCompletion.Choice['finish_reason'],
): OpenAI.Chat.ChatCompletion => ({
  id: 'cmpl_1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-x',
  choices: [
    {
      index: 0,
      finish_reason,
      logprobs: null,
      message: {
        role: 'assistant',
        content: null,
        refusal: null,
        ...message,
      },
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
});

describe('fromChatCompletion', () => {
  it('maps tool_calls to a single tool_use and stop_reason tool_use', () => {
    const m = fromChatCompletion(
      completion(
        {
          content: 'ok',
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: {
                name: 'record_decision',
                arguments: '{"decision":"REJECTED"}',
              },
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'request_approval', arguments: '{}' },
            },
          ],
        },
        'tool_calls',
      ),
    );
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content).toEqual([
      { type: 'text', text: 'ok', citations: null },
      {
        type: 'tool_use',
        id: 'call_a',
        name: 'record_decision',
        input: { decision: 'REJECTED' },
      },
    ]);
    expect(m.usage).toMatchObject({ input_tokens: 3, output_tokens: 4 });
  });

  it('turns invalid arguments JSON into an empty input', () => {
    const m = fromChatCompletion(
      completion(
        {
          tool_calls: [
            {
              id: 'c',
              type: 'function',
              function: { name: 'n', arguments: '{oops' },
            },
          ],
        },
        'tool_calls',
      ),
    );
    expect(m.content).toEqual([
      { type: 'tool_use', id: 'c', name: 'n', input: {} },
    ]);
  });

  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
  ] as const)('maps finish_reason %s to %s', (finish, stop) => {
    expect(
      fromChatCompletion(completion({ content: 'x' }, finish)).stop_reason,
    ).toBe(stop);
  });

  it('maps a refusal to stop_reason refusal', () => {
    expect(
      fromChatCompletion(completion({ refusal: 'no' }, 'stop')).stop_reason,
    ).toBe('refusal');
  });
});
