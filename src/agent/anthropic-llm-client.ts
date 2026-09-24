import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import type { LlmClient, LlmRequest } from './llm-client';
import { ANTHROPIC_SDK } from './llm-client';
import { createLlmSdk, isNativeAnthropic } from './llm-sdk';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

@Injectable()
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Optional() @Inject(ANTHROPIC_SDK) client?: Anthropic,
  ) {
    // SDK retries are off (llm-sdk.ts); 408/409/429/5xx go through the worker's backoff
    this.client = client ?? createLlmSdk(this.cfg);
  }

  createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.cfg.LLM_MODEL,
      max_tokens: 16000,
      system: req.system,
      tools: req.tools,
      messages: req.messages,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    };
    if (isNativeAnthropic(this.cfg)) {
      params.thinking = { type: 'adaptive' };
      if (this.cfg.ANTHROPIC_FALLBACK !== 'off') {
        // server-side refusal fallback (beta, D018): extra body field + beta header
        return this.client.messages.create(
          {
            ...params,
            fallbacks: 'default',
          } as Anthropic.MessageCreateParamsNonStreaming,
          { headers: { 'anthropic-beta': FALLBACK_BETA }, signal: req.signal },
        );
      }
    }
    return this.client.messages.create(
      params,
      req.signal ? { signal: req.signal } : undefined,
    );
  }
}
