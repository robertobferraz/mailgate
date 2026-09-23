import { Global, Module } from '@nestjs/common';
import { ActionRepository } from '../actions/action.repository';
import { ApprovalRepository } from '../approvals/approval.repository';
import { RunRepository } from '../runs/run.repository';
import { InboundEventRepository } from '../inbound/inbound-event.repository';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    PrismaService,
    RunRepository,
    ApprovalRepository,
    ActionRepository,
    InboundEventRepository,
  ],
  exports: [
    PrismaService,
    RunRepository,
    ApprovalRepository,
    ActionRepository,
    InboundEventRepository,
  ],
})
export class DatabaseModule {}
