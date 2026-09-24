import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { InboundEvent } from '../mail/mail-provider';
import { Db } from '../prisma/db';
import { PrismaService } from '../prisma/prisma.service';

export type InboundOutcome =
  | 'PROCESSED'
  | 'CLARIFICATION_SENT'
  | 'IGNORED_UNCLEAR'
  | 'IGNORED_UNKNOWN_THREAD'
  | 'IGNORED_SENDER'
  | 'IGNORED_ALREADY_DECIDED'
  | 'IGNORED_EXPIRED'
  | 'FAILED';

export interface InboundEventRow {
  providerEventId: string;
  event: InboundEvent;
  attempts: number;
}

@Injectable()
export class InboundEventRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** I3: dedupe by provider event id. False when already stored. */
  async insertIfAbsent(e: InboundEvent): Promise<boolean> {
    const { count } = await this.prisma.inboundEvent.createMany({
      data: [
        {
          providerEventId: e.eventId,
          payload: e as unknown as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async claimNext(
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<InboundEventRow | null> {
    const rows = await this.prisma.$queryRaw<
      { provider_event_id: string; payload: InboundEvent; attempts: number }[]
    >`
      WITH picked AS (
        SELECT provider_event_id FROM inbound_events
        WHERE outcome IS NULL AND attempts < ${maxAttempts}::int
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY received_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      UPDATE inbound_events e
         SET lease_until = now() + make_interval(secs => ${leaseSeconds}::float8), attempts = e.attempts + 1
        FROM picked
       WHERE e.provider_event_id = picked.provider_event_id
      RETURNING e.provider_event_id, e.payload, e.attempts`;
    const row = rows[0];
    return row
      ? {
          providerEventId: row.provider_event_id,
          event: row.payload,
          attempts: row.attempts,
        }
      : null;
  }

  /** Sets the terminal outcome once; false when another pass already set one (backlog 0009). */
  async setOutcome(
    db: Db,
    eventId: string,
    outcome: InboundOutcome,
    extra: { approvalRequestId?: string; classification?: string } = {},
  ): Promise<boolean> {
    const { count } = await db.inboundEvent.updateMany({
      where: { providerEventId: eventId, outcome: null },
      data: {
        outcome,
        processedAt: new Date(),
        leaseUntil: null,
        lastError: null,
        ...extra,
      },
    });
    return count === 1;
  }

  async recordError(eventId: string, error: string): Promise<void> {
    await this.prisma.inboundEvent.update({
      where: { providerEventId: eventId },
      data: { lastError: error },
    });
  }

  /** Dead-letter: keep the last error, stop retrying. */
  async markFailed(eventId: string, error: string): Promise<void> {
    await this.prisma.inboundEvent.updateMany({
      where: { providerEventId: eventId, outcome: null },
      data: {
        outcome: 'FAILED',
        lastError: error,
        leaseUntil: null,
        processedAt: new Date(),
      },
    });
  }

  /**
   * Recovers rows that died on their last attempt without ever recording an outcome
   * (crash, SIGKILL, shutdown, Prisma disconnect — backlog 0009): attempts already at
   * the max, no live lease, outcome still NULL. Runs on the DB clock (convention 0003).
   * Returns the number of rows dead-lettered.
   */
  async failExhausted(maxAttempts: number): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE inbound_events
         SET outcome = 'FAILED', processed_at = now(), lease_until = NULL,
             last_error = COALESCE(last_error, 'attempts exhausted without outcome')
       WHERE outcome IS NULL
         AND attempts >= ${maxAttempts}::int
         AND (lease_until IS NULL OR lease_until < now())`;
  }
}
