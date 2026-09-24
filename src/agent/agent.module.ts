import type Anthropic from '@anthropic-ai/sdk';
import { Module } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import { AgentRunner } from './agent-runner';
import { AnthropicLlmClient } from './anthropic-llm-client';
import { DemoLlmClient } from '../demo/demo-llm';
import { ANTHROPIC_SDK, LLM_CLIENT } from './llm-client';
import type { LlmClient } from './llm-client';
import { OpenAiLlmClient } from './openai-llm-client';

@Module({
  providers: [
    {
      provide: LLM_CLIENT,
      inject: [APP_CONFIG, { token: ANTHROPIC_SDK, optional: true }],
      useFactory: (cfg: AppConfig, sdk?: Anthropic): LlmClient =>
        cfg.DEMO
          ? new DemoLlmClient(cfg)
          : cfg.LLM_PROVIDER === 'openai-compatible'
            ? new OpenAiLlmClient(cfg)
            : new AnthropicLlmClient(cfg, sdk),
    },
    AgentRunner,
  ],
  exports: [AgentRunner, LLM_CLIENT],
})
export class AgentModule {}
