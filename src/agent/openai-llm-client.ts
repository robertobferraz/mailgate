import type Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AppConfig } from '../config/config';
import type { LlmClient, LlmRequest } from './llm-client';
import { fromChatCompletion, toChatRequest } from './openai-translate';

export function createOpenAiSdk(cfg: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: cfg.LLM_API_KEY,
    baseURL: cfg.LLM_BASE_URL, // undefined -> api.openai.com
    timeout: cfg.LLM_TIMEOUT_MS,
    maxRetries: 0, // the worker's backoff retries (adr 0007)
  });
}

/** Groq/OpenAI over chat.completions, returning Anthropic.Message (adr 0010, convention 0005). */
export class OpenAiLlmClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(
    private readonly cfg: AppConfig,
    client?: OpenAI,
  ) {
    this.client = client ?? createOpenAiSdk(cfg);
  }

  async createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    const c = await this.client.chat.completions.create(
      toChatRequest(req, this.cfg.LLM_MODEL),
      { signal: req.signal },
    );
    return fromChatCompletion(c);
  }
}
