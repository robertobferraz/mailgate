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

const SEND_LEASE_SECONDS = 60;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  /**
   * Reserves one live, due CREATED request at a time (FOR UPDATE SKIP LOCKED + send_lease_until),
   * sends outside any transaction (convention 0004), then marks SENT (D016). adr 0009.
   * `shouldStop`, when given, is checked before reserving each next row so a caller
   * draining on shutdown can stop between sends instead of starting a fresh 20s send.
   */
  async dispatch(shouldStop?: () => boolean): Promise<number> {
    let sent = 0;
    for (let i = 0; i < this.cfg.OUTBOX_BATCH; i++) {
      if (shouldStop?.()) break;
      const id = await this.reserve();
      if (!id) break;
      if (await this.sendOne(id)) sent++;
    }
    return sent;
  }

  private async reserve(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH picked AS (
        SELECT id FROM approval_requests
         WHERE status = 'CREATED' AND expires_at > now()
           AND (next_send_at IS NULL OR next_send_at <= now())
           AND (send_lease_until IS NULL OR send_lease_until < now())
         ORDER BY next_send_at NULLS FIRST, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      UPDATE approval_requests a
         SET send_lease_until = now() + make_interval(secs => ${SEND_LEASE_SECONDS}::float8), updated_at = now()
        FROM picked WHERE a.id = picked.id
      RETURNING a.id`;
    return rows[0]?.id ?? null;
  }

  private async sendOne(id: string): Promise<boolean> {
    const a = await this.prisma.approvalRequest.findUniqueOrThrow({
      where: { id },
      include: { run: true },
    });
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
      return await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.approvalRequest.updateMany({
          where: { id: a.id, status: 'CREATED' },
          data: {
            status: 'SENT',
            providerMessageId: res.messageId,
            providerThreadId: res.threadId,
            lastError: null,
            sendLeaseUntil: null,
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
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`send failed for approval ${a.id}: ${message}`);
      // backoff on the DB clock (convention 0003): 30s, 60s, 120s ... capped at 1h
      await this.prisma.$executeRaw`
        UPDATE approval_requests
           SET last_error = ${message}, send_lease_until = NULL, updated_at = now(),
               next_send_at = now() + make_interval(secs => LEAST(30 * power(2, send_attempts), 3600)::float8),
               send_attempts = send_attempts + 1
         WHERE id = ${a.id}::uuid AND status = 'CREATED'`;
      return false;
    }
  }
}
