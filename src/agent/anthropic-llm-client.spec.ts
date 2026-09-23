import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config/config';
import { AnthropicLlmClient } from './anthropic-llm-client';
import { TOOLS } from './tools';

const cfg = (extra: Record<string, string> = {}) =>
  loadConfig({ DATABASE_URL: 'postgresql://x', ...extra });

describe('AnthropicLlmClient', () => {
  const req = {
    system: 'sys',
    tools: TOOLS,
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('sends model, adaptive thinking, one tool per turn and the server-side fallback', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'm' });
    const client = new AnthropicLlmClient(cfg(), {
      messages: { create },
    } as unknown as Anthropic);
    await client.createMessage(req);
    const [params, options] = create.mock.calls[0] as [
      Record<string, unknown>,
      { headers?: Record<string, string> } | undefined,
    ];
    expect(params).toMatchObject({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive' },
      system: 'sys',
      fallbacks: 'default',
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
    expect(options).toEqual({
      headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    });
  });

  it('omits the fallback when ANTHROPIC_FALLBACK=off', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'm' });
    await new AnthropicLlmClient(cfg({ ANTHROPIC_FALLBACK: 'off' }), {
      messages: { create },
    } as unknown as Anthropic).createMessage(req);
    const [params, options] = create.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(params).not.toHaveProperty('fallbacks');
    expect(options).toBeUndefined();
  });

  it('sends LLM_MODEL, keeps tools/system/messages/tool_choice, and omits thinking/fallbacks/options for anthropic-compatible', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'm' });
    await new AnthropicLlmClient(
      cfg({
        LLM_PROVIDER: 'anthropic-compatible',
        LLM_BASE_URL: 'http://localhost:11434',
        LLM_MODEL: 'qwen3:8b',
        ANTHROPIC_FALLBACK: 'default',
      }),
      { messages: { create } } as unknown as Anthropic,
    ).createMessage(req);
    const [params, options] = create.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(params).toMatchObject({
      model: 'qwen3:8b',
      tools: TOOLS,
      system: 'sys',
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('fallbacks');
    expect(params.messages).toEqual(req.messages);
    expect(options).toBeUndefined();
  });
});
