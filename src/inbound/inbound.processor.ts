import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ApprovalRepository,
  ApprovalRequest,
} from '../approvals/approval.repository';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { PrismaClient } from '../generated/prisma/client';
import { InboundEvent, MAIL_PROVIDER } from '../mail/mail-provider';
import type { MailProvider } from '../mail/mail-provider';
import { renderClarificationEmail } from '../mail/templates';
import { PrismaService } from '../prisma/prisma.service';
import { appendRunEvent } from '../runs/run-events';
import { RunRepository } from '../runs/run.repository';
import { extractSubjectToken } from './correlation';
import { InboundEventRepository } from './inbound-event.repository';
import { REPLY_CLASSIFIER } from './reply-classifier';
import type { Classification, ReplyClassifier } from './reply-classifier';

@Injectable()
export class InboundProcessor {
  private readonly logger = new Logger(InboundProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly events: InboundEventRepository,
    private readonly approvals: ApprovalRepository,
    private readonly runs: RunRepository,
    @Inject(REPLY_CLASSIFIER) private readonly classifier: ReplyClassifier,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  /** Claims and handles one pending inbound event. False when none is pending. */
  async processNext(): Promise<boolean> {
    const row = await this.events.claimNext(
      this.cfg.LEASE_SECONDS,
      this.cfg.MAX_ATTEMPTS,
    );
    if (!row) return false;
    try {
      await this.handle(row.providerEventId, row.event);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `inbound ${row.providerEventId} failed (attempt ${row.attempts}): ${message}`,
      );
      await this.events.recordError(row.providerEventId, message);
    }
    return true;
  }

  private async handle(eventId: string, event: InboundEvent): Promise<void> {
    const approval = await this.approvals.findForCorrelation(
      event.threadId,
      extractSubjectToken(event.subject),
    );
    if (!approval)
      return this.events.setOutcome(
        this.prisma,
        eventId,
        'IGNORED_UNKNOWN_THREAD',
      );

    const link = { approvalRequestId: approval.id };
    if (event.from.toLowerCase() !== approval.approverEmail) {
      return this.events.setOutcome(
        this.prisma,
        eventId,
        'IGNORED_SENDER',
        link,
      ); // I6
    }
    // cheap pre-check without lock; the authoritative check is under FOR UPDATE below
    if (approval.status !== 'SENT')
      return this.events.setOutcome(
        this.prisma,
        eventId,
        'IGNORED_ALREADY_DECIDED',
        link,
      );

    const c = await this.classifier.classify(event.text); // outside any transaction (convention 0004)
    if (c.decision === 'UNCLEAR')
      return this.handleUnclear(eventId, event, approval, c);
    await this.decide(eventId, event, approval, c);
  }

  /** I2: lock the approval row, check SENT, decide, resume the run, all in one transaction. */
  private async decide(
    eventId: string,
    event: InboundEvent,
    approval: ApprovalRequest,
    c: Classification,
  ): Promise<void> {
    const extra = {
      approvalRequestId: approval.id,
      classification: c.decision,
    };
    await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM approval_requests WHERE id = ${approval.id}::uuid FOR UPDATE`;
      if (locked?.status !== 'SENT') {
        await this.events.setOutcome(
          tx,
          eventId,
          'IGNORED_ALREADY_DECIDED',
          extra,
        );
        return;
      }
      await tx.approvalRequest.update({
        where: { id: approval.id },
        data: {
          status: 'DECIDED',
          decision: c.decision,
          decisionNote: c.note,
          decisionRawText: event.text,
        },
      });
      if (!(await this.runs.resumeFromDecision(tx, approval.runId))) {
        throw new Error(`run ${approval.runId} is not WAITING_APPROVAL`);
      }
      await appendRunEvent(tx, approval.runId, 'DECISION_RECEIVED', {
        approvalId: approval.id,
        decision: c.decision,
        from: event.from,
      });
      await this.events.setOutcome(tx, eventId, 'PROCESSED', extra);
    });
  }

  /** At most one clarification per approval: send first (idempotent key), then flip the flag. */
  private async handleUnclear(
    eventId: string,
    event: InboundEvent,
    approval: ApprovalRequest,
    c: Classification,
  ): Promise<void> {
    const extra = {
      approvalRequestId: approval.id,
      classification: c.decision,
    };
    if (approval.clarificationSent)
      return this.events.setOutcome(
        this.prisma,
        eventId,
        'IGNORED_UNCLEAR',
        extra,
      );

    const body = renderClarificationEmail();
    await this.mail.reply({
      messageId: event.messageId,
      ...body,
      idempotencyKey: `clarify-${approval.id}`,
    });
    const { count } = await this.prisma.approvalRequest.updateMany({
      where: { id: approval.id, clarificationSent: false },
      data: { clarificationSent: true },
    });
    await this.events.setOutcome(
      this.prisma,
      eventId,
      count === 1 ? 'CLARIFICATION_SENT' : 'IGNORED_UNCLEAR',
      extra,
    );
  }
}
