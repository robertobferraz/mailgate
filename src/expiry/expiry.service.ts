import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { appendRunEvent } from '../runs/run-events';
import { RunRepository } from '../runs/run.repository';

const BATCH = 50;

@Injectable()
export class ExpiryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly runs: RunRepository,
  ) {}

  /** Expires CREATED/SENT requests past expires_at and their runs, atomically (D013). */
  async expireDue(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<{ id: string; run_id: string }[]>`
        SELECT id, run_id FROM approval_requests
         WHERE status IN ('CREATED','SENT') AND expires_at < now()
         ORDER BY expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT ${BATCH}::int`;
      for (const a of due) {
        await tx.approvalRequest.updateMany({
          where: { id: a.id, status: { in: ['CREATED', 'SENT'] } },
          data: { status: 'EXPIRED' },
        });
        if (await this.runs.expireWaiting(tx, a.run_id)) {
          await appendRunEvent(tx, a.run_id, 'EXPIRED', { approvalId: a.id });
        }
      }
      return due.length;
    });
  }
}
