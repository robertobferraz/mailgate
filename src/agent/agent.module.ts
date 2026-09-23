import { Module } from '@nestjs/common';
import { AgentRunner } from './agent-runner';
import { AnthropicLlmClient } from './anthropic-llm-client';
import { LLM_CLIENT } from './llm-client';

@Module({
  providers: [
    { provide: LLM_CLIENT, useClass: AnthropicLlmClient },
    AgentRunner,
  ],
  exports: [AgentRunner, LLM_CLIENT],
})
export class AgentModule {}
