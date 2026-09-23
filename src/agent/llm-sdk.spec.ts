import { loadConfig } from '../config/config';
import { createLlmSdk, isNativeAnthropic } from './llm-sdk';

const cfg = (extra: Record<string, string> = {}) =>
  loadConfig({ DATABASE_URL: 'postgresql://x', ...extra });

describe('createLlmSdk', () => {
  it('uses LLM_BASE_URL and the not-needed placeholder key for anthropic-compatible without a key', () => {
    const client = createLlmSdk(
      cfg({
        LLM_PROVIDER: 'anthropic-compatible',
        LLM_BASE_URL: 'http://localhost:11434',
      }),
    );
    expect(client.baseURL).toBe('http://localhost:11434');
    expect(client.apiKey).toBe('not-needed');
  });

  it('uses the SDK default baseURL and LLM_API_KEY for provider anthropic', () => {
    const client = createLlmSdk(cfg({ LLM_API_KEY: 'k' }));
    expect(client.apiKey).toBe('k');
    expect(client.baseURL).toBe('https://api.anthropic.com');
  });
});

describe('isNativeAnthropic', () => {
  it('is true for provider anthropic', () => {
    expect(isNativeAnthropic(cfg())).toBe(true);
  });

  it('is false for provider anthropic-compatible', () => {
    expect(
      isNativeAnthropic(
        cfg({
          LLM_PROVIDER: 'anthropic-compatible',
          LLM_BASE_URL: 'http://localhost:11434',
        }),
      ),
    ).toBe(false);
  });
});
