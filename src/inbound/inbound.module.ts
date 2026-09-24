import type Anthropic from '@anthropic-ai/sdk';
import { Module } from '@nestjs/common';
import { ANTHROPIC_SDK } from '../agent/llm-client';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import { MailModule } from '../mail/mail.module';
import { KeywordClassifier } from '../demo/keyword-classifier';
import { ClaudeReplyClassifier } from './claude-reply-classifier';
import { InboundProcessor } from './inbound.processor';
import { OpenAiReplyClassifier } from './openai-reply-classifier';
import type { ReplyClassifier } from './reply-classifier';
import { REPLY_CLASSIFIER } from './reply-classifier';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [MailModule],
  controllers: [WebhookController],
  providers: [
    {
      provide: REPLY_CLASSIFIER,
      inject: [APP_CONFIG, { token: ANTHROPIC_SDK, optional: true }],
      useFactory: (cfg: AppConfig, sdk?: Anthropic): ReplyClassifier =>
        cfg.DEMO
          ? new KeywordClassifier()
          : cfg.LLM_PROVIDER === 'openai-compatible'
            ? new OpenAiReplyClassifier(cfg)
            : new ClaudeReplyClassifier(cfg, sdk),
    },
    InboundProcessor,
  ],
  exports: [InboundProcessor],
})
export class InboundModule {}
