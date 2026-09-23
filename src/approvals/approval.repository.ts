import { Inject, Injectable } from '@nestjs/common';
import {
  ApprovalRequest as ApprovalModel,
  PrismaClient,
} from '../generated/prisma/client';
import { Db } from '../prisma/db';
import { PrismaService } from '../prisma/prisma.service';
import { newSubjectToken } from './subject-token';

export type ApprovalStatus = 'CREATED' | 'SENT' | 'DECIDED' | 'EXPIRED';
export type Decision = 'APPROVED' | 'REJECTED';

export interface ApprovalRequest extends Omit<
  ApprovalModel,
  'status' | 'decision' | 'recommendation'
> {
  status: ApprovalStatus;
  decision: Decision | null;
  recommendation: 'APPROVE' | 'REJECT';
}

const toApproval = (m: ApprovalModel): ApprovalRequest => m as ApprovalRequest;

@Injectable()
export class ApprovalRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** INSERT ... ON CONFLICT DO NOTHING: safe inside transactions (convention 0002). */
  async createIfAbsent(
    db: Db,
    p: {
      runId: string;
      toolUseId: string;
      approverEmail: string;
      summary: string;
      recommendation: 'APPROVE' | 'REJECT';
      rationale: string;
      ttlHours: number;
    },
  ): Promise<void> {
    await db.$executeRaw`
      INSERT INTO approval_requests
        (id, run_id, tool_use_id, approver_email, subject_token, summary, recommendation, rationale, status, expires_at, created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${p.runId}::uuid, ${p.toolUseId}, ${p.approverEmail.toLowerCase()}, ${newSubjectToken()},
         ${p.summary}, ${p.recommendation}, ${p.rationale}, 'CREATED',
         now() + make_interval(hours => ${p.ttlHours}::int), now(), now())
      ON CONFLICT (run_id, tool_use_id) DO NOTHING`;
  }

  async findByToolUse(
    db: Db,
    runId: string,
    toolUseId: string,
  ): Promise<ApprovalRequest | null> {
    const m = await db.approvalRequest.findUnique({
      where: { runId_toolUseId: { runId, toolUseId } },
    });
    return m ? toApproval(m) : null;
  }

  async findLatestForRun(
    db: Db,
    runId: string,
  ): Promise<ApprovalRequest | null> {
    const m = await db.approvalRequest.findFirst({
      where: { runId },
      orderBy: { createdAt: 'desc' },
    });
    return m ? toApproval(m) : null;
  }

  async findDecidedForRun(
    db: Db,
    runId: string,
  ): Promise<ApprovalRequest | null> {
    const m = await db.approvalRequest.findFirst({
      where: { runId, status: 'DECIDED' },
      orderBy: { createdAt: 'desc' },
    });
    return m ? toApproval(m) : null;
  }

  async findForCorrelation(
    threadId: string | null,
    subjectToken: string | null,
  ): Promise<ApprovalRequest | null> {
    if (threadId) {
      const byThread = await this.prisma.approvalRequest.findFirst({
        where: { providerThreadId: threadId },
      });
      if (byThread) return toApproval(byThread);
    }
    if (subjectToken) {
      const byToken = await this.prisma.approvalRequest.findUnique({
        where: { subjectToken },
      });
      if (byToken) return toApproval(byToken);
    }
    return null;
  }
}
