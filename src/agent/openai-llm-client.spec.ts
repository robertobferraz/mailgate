import type OpenAI from 'openai';
import { loadConfig } from '../config/config';
import { OpenAiLlmClient } from './openai-llm-client';

describe('OpenAiLlmClient', () => {
  it('calls chat.completions with the translated request and the abort signal', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'c',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: { role: 'assistant', content: 'oi', refusal: null },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const sdk = { chat: { completions: { create } } } as unknown as OpenAI;
    const cfg = loadConfig({
      DATABASE_URL: 'postgresql://x',
      LLM_PROVIDER: 'openai-compatible',
      LLM_API_KEY: 'k',
      LLM_MODEL: 'gpt-x',
    });
    const signal = new AbortController().signal;
    const m = await new OpenAiLlmClient(cfg, sdk).createMessage({
      system: 'S',
      tools: [],
      messages: [{ role: 'user', content: 'u' }],
      signal,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-x' }),
      { signal },
    );
    expect(m.stop_reason).toBe('end_turn');
  });
});
