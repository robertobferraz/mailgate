import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementInput } from '../runs/reimbursement-input';
import { appendRunEvent } from '../runs/run-events';
import { MAIL_PROVIDER } from './mail-provider';
import type { MailProvider } from './mail-provider';
import { renderApprovalEmail } from './templates';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  /** Sends CREATED approval requests. Never sends inside a DB transaction (convention 0004). */
  async dispatch(): Promise<number> {
    const pending = await this.prisma.approvalRequest.findMany({
      where: { status: 'CREATED' },
      orderBy: [
        { lastError: { sort: 'asc', nulls: 'first' } },
        { updatedAt: 'asc' },
      ],
      take: this.cfg.OUTBOX_BATCH,
      include: { run: true },
    });

    let sent = 0;
    for (const a of pending) {
      const input = a.run.input as unknown as ReimbursementInput;
      const email = renderApprovalEmail({
        subjectToken: a.subjectToken,
        description: input.description,
        category: input.category,
        amountCents: input.amountCents,
        requesterEmail: input.requesterEmail,
        summary: a.summary,
        recommendation: a.recommendation as 'APPROVE' | 'REJECT',
        rationale: a.rationale,
        expiresAt: a.expiresAt,
      });
      try {
        const res = await this.mail.send({
          to: a.approverEmail,
          ...email,
          idempotencyKey: `approval-${a.id}`,
        });
        const marked = await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.approvalRequest.updateMany({
            where: { id: a.id, status: 'CREATED' },
            data: {
              status: 'SENT',
              providerMessageId: res.messageId,
              providerThreadId: res.threadId,
              lastError: null,
            },
          });
          if (count === 1) {
            await appendRunEvent(tx, a.runId, 'APPROVAL_SENT', {
              approvalId: a.id,
              threadId: res.threadId,
            });
          }
          return count === 1;
        });
        if (marked) sent++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(`send failed for approval ${a.id}: ${message}`);
        await this.prisma.approvalRequest.updateMany({
          where: { id: a.id, status: 'CREATED' },
          data: { lastError: message },
        });
      }
    }
    return sent;
  }
}
