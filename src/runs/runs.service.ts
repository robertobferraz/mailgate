import { Inject, Injectable } from '@nestjs/common';
import { ActionRepository } from '../actions/action.repository';
import { ApprovalRepository } from '../approvals/approval.repository';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementInput } from './reimbursement-input';
import { Run } from './run';
import { RunRepository } from './run.repository';

export interface RunView {
  id: string;
  status: Run['status'];
  input: ReimbursementInput;
  attempts: number;
  lastError: string | null;
  approval: {
    status: string;
    decision: string | null;
    note: string | null;
    expiresAt: Date;
  } | null;
  action: { type: string; payload: unknown; createdAt: Date } | null;
  timeline: { at: Date; type: string; data: unknown }[];
}

@Injectable()
export class RunsService {
  constructor(
    private readonly runs: RunRepository,
    private readonly approvals: ApprovalRepository,
    private readonly actions: ActionRepository,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
  ) {}

  create(input: ReimbursementInput): Promise<Run> {
    return this.runs.create(input);
  }

  async getView(id: string): Promise<RunView | null> {
    const run = await this.runs.findById(id);
    if (!run) return null;
    const events = await this.prisma.runEvent.findMany({
      where: { runId: id },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    const approval = await this.approvals.findLatestForRun(this.prisma, id);
    const action = await this.actions.findForRun(this.prisma, id);
    return {
      id: run.id,
      status: run.status,
      input: run.input,
      attempts: run.attempts,
      lastError: run.lastError,
      approval: approval
        ? {
            status: approval.status,
            decision: approval.decision,
            note: approval.decisionNote,
            expiresAt: approval.expiresAt,
          }
        : null,
      action: action
        ? {
            type: action.type,
            payload: action.payload,
            createdAt: action.createdAt,
          }
        : null,
      timeline: events.map((e) => ({ at: e.at, type: e.type, data: e.data })),
    };
  }
}
