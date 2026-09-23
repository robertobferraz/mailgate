import { Inject, Injectable } from '@nestjs/common';
import { Action, Prisma, PrismaClient } from '../generated/prisma/client';
import { Db } from '../prisma/db';
import { PrismaService } from '../prisma/prisma.service';

export type ActionType = 'REIMBURSEMENT_APPROVED' | 'REIMBURSEMENT_REJECTED';
export type ActionRecord = Action;

@Injectable()
export class ActionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** I1: at most one action per (run_id, tool_use_id). Returns false when it already existed. */
  async recordIfAbsent(
    db: Db,
    p: {
      runId: string;
      toolUseId: string;
      type: ActionType;
      payload: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const { count } = await db.action.createMany({
      data: [
        {
          runId: p.runId,
          toolUseId: p.toolUseId,
          type: p.type,
          payload: p.payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  findForRun(db: Db, runId: string): Promise<ActionRecord | null> {
    return db.action.findFirst({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
