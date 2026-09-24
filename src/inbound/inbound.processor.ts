import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ApprovalRepository,
  ApprovalRequest,
  Liveness,
} from '../approvals/approval.repository';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { PrismaClient } from '../generated/prisma/client';
import { InboundEvent, MAIL_PROVIDER } from '../mail/mail-provider';
import type { MailProvider } from '../mail/mail-provider';
import {
  renderClarificationEmail,
  renderLateReplyEmail,
} from '../mail/templates';
import { PrismaService } from '../prisma/prisma.service';
import { appendRunEvent } from '../runs/run-events';
import { RunRepository } from '../runs/run.repository';
import { extractSubjectToken } from './correlation';
import { InboundEventRepository } from './inbound-event.repository';
import type { InboundOutcome } from './inbound-event.repository';
import { REPLY_CLASSIFIER } from './reply-classifier';
import type { Classification, ReplyClassifier } from './reply-classifier';

/** Outcome recorded for a reply that finds its request no longer live (D008). */
const IGNORED_FOR: Record<Exclude<Liveness, 'LIVE'>, InboundOutcome> = {
  DECIDED: 'IGNORED_ALREADY_DECIDED',
  EXPIRED: 'IGNORED_EXPIRED',
  NOT_SENT: 'IGNORED_ALREADY_DECIDED',
};

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
    const recovered = await this.events.failExhausted(this.cfg.MAX_ATTEMPTS);
    if (recovered > 0) {
      this.logger.warn(
        `inbound: dead-lettered ${recovered} event(s) that died past attempts exhaustion without an outcome`,
      );
    }
    const row = await this.events.claimNext(
      this.cfg.LEASE_SECONDS,
      this.cfg.MAX_ATTEMPTS,
    );
    if (!row) return false;
    try {
      await this.handle(row.providerEventId, row.event);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (row.attempts >= this.cfg.MAX_ATTEMPTS) {
        this.logger.error(
          `inbound ${row.providerEventId} dead-lettered after ${row.attempts} attempts: ${message}`,
        );
        await this.events.markFailed(row.providerEventId, message);
      } else {
        this.logger.warn(
          `inbound ${row.providerEventId} failed (attempt ${row.attempts}): ${message}`,
        );
        await this.events.recordError(row.providerEventId, message);
      }
    }
    return true;
  }

  private async handle(eventId: string, event: InboundEvent): Promise<void> {
    const approval = await this.approvals.findForCorrelation(
      event.threadId,
      extractSubjectToken(event.subject),
    );
    if (!approval) {
      await this.events.setOutcome(
        this.prisma,
        eventId,
        'IGNORED_UNKNOWN_THREAD',
      );
      return;
    }

    const link = { approvalRequestId: approval.id };
    if (event.from.toLowerCase() !== approval.approverEmail) {
      await this.events.setOutcome(
        this.prisma,
        eventId,
        'IGNORED_SENDER',
        link,
      ); // I6
      return;
    }
    // cheap pre-check without lock on the DB clock; the authoritative check is under FOR UPDATE in decide
    const state = await this.approvals.liveness(this.prisma, approval.id);
    if (state !== 'LIVE') {
      if (state !== 'NOT_SENT') await this.sendLateReply(event, approval.id);
      await this.events.setOutcome(
        this.prisma,
        eventId,
        IGNORED_FOR[state],
        link,
      );
      return;
    }

    const c = await this.classifier.classify(event.text); // outside any transaction (convention 0004)
    if (c.decision === 'UNCLEAR')
      return this.handleUnclear(eventId, event, approval, c);
    await this.decide(eventId, event, approval, c);
  }

  /**
   * I2 + D008: lock the approval row, require it SENT and before expires_at (DB clock), decide,
   * resume the run, all in one transaction. Returns 'LIVE' when it decided, otherwise the state
   * it found; a non-live outcome is recorded after the commit.
   */
  private async decide(
    eventId: string,
    event: InboundEvent,
    approval: ApprovalRequest,
    c: Classification,
  ): Promise<Liveness> {
    const extra = {
      approvalRequestId: approval.id,
      classification: c.decision,
    };
    const state = await this.prisma.$transaction(async (tx) => {
      const s = await this.approvals.liveness(tx, approval.id, true);
      if (s !== 'LIVE') return s;
      await tx.$executeRaw`
        UPDATE approval_requests SET status = 'DECIDED', decision = ${c.decision}, decision_note = ${c.note},
               decision_raw_text = ${event.text}, decided_at = now(), updated_at = now()
         WHERE id = ${approval.id}::uuid`;
      if (!(await this.runs.resumeFromDecision(tx, approval.runId))) {
        throw new Error(`run ${approval.runId} is not WAITING_APPROVAL`);
      }
      await appendRunEvent(tx, approval.runId, 'DECISION_RECEIVED', {
        approvalId: approval.id,
        decision: c.decision,
        from: event.from,
      });
      await this.events.setOutcome(tx, eventId, 'PROCESSED', extra);
      return s;
    });
    if (state === 'DECIDED' || state === 'EXPIRED')
      await this.sendLateReply(event, approval.id);
    if (state !== 'LIVE')
      await this.events.setOutcome(
        this.prisma,
        eventId,
        IGNORED_FOR[state],
        extra,
      );
    return state;
  }

  /** At most one late reply per approval (pdr 0005): send first (idempotent key), then flip the flag. */
  private async sendLateReply(
    event: InboundEvent,
    approvalId: string,
  ): Promise<void> {
    const a = await this.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });
    if (a.lateReplySent) return;
    const decided = a.status === 'DECIDED' && a.decision;
    const body = renderLateReplyEmail({
      state: decided ? (a.decision as 'APPROVED' | 'REJECTED') : 'EXPIRED',
      at: decided ? (a.decidedAt ?? a.updatedAt) : a.expiresAt,
      note: decided ? a.decisionNote : null,
    });
    await this.mail.reply({
      messageId: event.messageId,
      ...body,
      idempotencyKey: `late-${a.id}`,
    });
    await this.prisma.approvalRequest.updateMany({
      where: { id: a.id, lateReplySent: false },
      data: { lateReplySent: true },
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
    if (approval.clarificationSent) {
      await this.events.setOutcome(
        this.prisma,
        eventId,
        'IGNORED_UNCLEAR',
        extra,
      );
      return;
    }

    // the deadline may have passed while the classifier ran: no clarification for a dead request
    if ((await this.approvals.liveness(this.prisma, approval.id)) !== 'LIVE') {
      await this.events.setOutcome(
        this.prisma,
        eventId,
        'IGNORED_UNCLEAR',
        extra,
      );
      return;
    }

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
