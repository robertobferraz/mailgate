import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { ClaudeReplyClassifier } from './claude-reply-classifier';
import { InboundProcessor } from './inbound.processor';
import { REPLY_CLASSIFIER } from './reply-classifier';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [MailModule],
  controllers: [WebhookController],
  providers: [
    { provide: REPLY_CLASSIFIER, useClass: ClaudeReplyClassifier },
    InboundProcessor,
  ],
  exports: [InboundProcessor],
})
export class InboundModule {}
