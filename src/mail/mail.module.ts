import { Module } from '@nestjs/common';
import { AgentMailProvider } from './agentmail.provider';
import { MAIL_PROVIDER } from './mail-provider';
import { OutboxService } from './outbox.service';

@Module({
  providers: [
    { provide: MAIL_PROVIDER, useClass: AgentMailProvider },
    OutboxService,
  ],
  exports: [MAIL_PROVIDER, OutboxService],
})
export class MailModule {}
