import { Module } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import { DemoMailProvider } from '../demo/demo-mail.provider';
import { AgentMailProvider } from './agentmail.provider';
import type { MailProvider } from './mail-provider';
import { MAIL_PROVIDER } from './mail-provider';
import { OutboxService } from './outbox.service';

@Module({
  providers: [
    {
      provide: MAIL_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig): MailProvider =>
        cfg.DEMO ? new DemoMailProvider(cfg) : new AgentMailProvider(cfg),
    },
    OutboxService,
  ],
  exports: [MAIL_PROVIDER, OutboxService],
})
export class MailModule {}
