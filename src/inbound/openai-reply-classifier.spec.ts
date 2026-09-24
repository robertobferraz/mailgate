import type OpenAI from 'openai';
import { loadConfig } from '../config/config';
import { OpenAiReplyClassifier } from './openai-reply-classifier';

const cfg = (strict = 'false') =>
  loadConfig({
    DATABASE_URL: 'postgresql://x',
    LLM_PROVIDER: 'openai-compatible',
    LLM_API_KEY: 'k',
    LLM_STRICT_OUTPUT: strict,
  });

const sdkReturning = (content: string, finishReason = 'stop') => {
  const create = jest.fn().mockResolvedValue({
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: 'assistant', content, refusal: null },
      },
    ],
  });
  return {
    sdk: { chat: { completions: { create } } } as unknown as OpenAI,
    create,
  };
};

interface RequestBody {
  messages: { role: string; content: string }[];
  max_completion_tokens: number;
  response_format: {
    type: string;
    json_schema: {
      strict: boolean;
      schema: { additionalProperties?: boolean; $schema?: string };
    };
  };
}

describe('OpenAiReplyClassifier', () => {
  it('parses a valid json_schema answer', async () => {
    const { sdk, create } = sdkReturning('{"decision":"APPROVED","note":"ok"}');
    expect(
      await new OpenAiReplyClassifier(cfg('true'), sdk).classify('aprovo'),
    ).toEqual({ decision: 'APPROVED', note: 'ok' });
    const [params] = create.mock.calls[0] as [RequestBody];
    expect(params.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    });
    expect(params.response_format.json_schema.schema.additionalProperties).toBe(
      false,
    );
  });

  it('sends max_completion_tokens 2000 and a schema without $schema', async () => {
    const { sdk, create } = sdkReturning('{"decision":"APPROVED","note":"ok"}');
    await new OpenAiReplyClassifier(cfg(), sdk).classify('aprovo');
    const [params] = create.mock.calls[0] as [RequestBody];
    expect(params.max_completion_tokens).toBe(2000);
    expect(params.response_format.json_schema.schema.$schema).toBeUndefined();
  });

  it('throws when finish_reason is length instead of returning UNCLEAR', async () => {
    const { sdk } = sdkReturning('{"decision":"APPRO', 'length');
    await expect(
      new OpenAiReplyClassifier(cfg(), sdk).classify('aprovo'),
    ).rejects.toThrow(/finish_reason=length/);
  });

  it('falls back to UNCLEAR on invalid output', async () => {
    const { sdk } = sdkReturning('não sei');
    expect(
      (await new OpenAiReplyClassifier(cfg(), sdk).classify('?')).decision,
    ).toBe('UNCLEAR');
  });

  it('uses the same framing as ClaudeReplyClassifier for the user message', async () => {
    const { sdk, create } = sdkReturning('{"decision":"APPROVED","note":"ok"}');
    await new OpenAiReplyClassifier(cfg(), sdk).classify('aprovo');
    const [params] = create.mock.calls[0] as [RequestBody];
    const userMessage = params.messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toBe('Resposta do gestor:\n"""\naprovo\n"""');
  });
});
