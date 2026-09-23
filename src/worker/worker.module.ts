import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AgentRunner } from '../agent/agent-runner';
import { ExpiryModule } from '../expiry/expiry.module';
import { InboundModule } from '../inbound/inbound.module';
import { MailModule } from '../mail/mail.module';
import { AGENT_STEP } from './agent-step';
import { WorkerLoop } from './worker.loop';
import { WorkerService } from './worker.service';

@Module({
  imports: [AgentModule, MailModule, InboundModule, ExpiryModule],
  providers: [
    { provide: AGENT_STEP, useExisting: AgentRunner },
    WorkerService,
    WorkerLoop,
  ],
  exports: [WorkerService, WorkerLoop],
})
export class WorkerModule {}
