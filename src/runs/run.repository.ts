import { Inject, Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Db } from '../prisma/db';
import { ReimbursementInput } from './reimbursement-input';
import { appendRunEvent } from './run-events';
import {
  LeaseLostError,
  Lease,
  modelToRun,
  Run,
  RunRow,
  rowToRun,
} from './run';

@Injectable()
export class RunRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  async create(input: ReimbursementInput): Promise<Run> {
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.run.create({
        data: { status: 'PENDING', input },
      });
      await appendRunEvent(tx, m.id, 'CREATED');
      return modelToRun(m);
    });
  }

  async findById(id: string): Promise<Run | null> {
    const m = await this.prisma.run.findUnique({ where: { id } });
    return m ? modelToRun(m) : null;
  }

  async claim(
    leaseSeconds: number,
  ): Promise<{ run: Run; lease: Lease; reclaimed: boolean } | null> {
    const rows = await this.prisma.$queryRaw<
      (RunRow & { prev_status: string })[]
    >`
      WITH picked AS (
        SELECT id, status AS prev_status FROM runs
        WHERE (status = 'PENDING' AND (lease_until IS NULL OR lease_until <= now()))
           OR (status = 'RUNNING' AND lease_until < now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      UPDATE runs r
         SET status = 'RUNNING', lease_token = gen_random_uuid(),
             lease_until = now() + make_interval(secs => ${leaseSeconds}::float8),
             attempts = r.attempts + 1, updated_at = now()
        FROM picked
       WHERE r.id = picked.id
      RETURNING r.*, picked.prev_status`;
    const row = rows[0];
    if (!row) return null;
    const run = rowToRun(row);
    const reclaimed = row.prev_status === 'RUNNING';
    if (reclaimed)
      await appendRunEvent(this.prisma, run.id, 'LEASE_LOST', {
        attempts: run.attempts,
      });
    await appendRunEvent(this.prisma, run.id, 'CLAIMED', {
      attempts: run.attempts,
    });
    return { run, lease: { runId: run.id, token: run.leaseToken! }, reclaimed };
  }

  async saveMessages(
    lease: Lease,
    messages: Anthropic.MessageParam[],
    leaseSeconds: number,
  ): Promise<void> {
    const n = await this.prisma.$executeRaw`
      UPDATE runs SET messages = ${JSON.stringify(messages)}::jsonb,
             lease_until = now() + make_interval(secs => ${leaseSeconds}::float8), updated_at = now()
       WHERE id = ${lease.runId}::uuid AND lease_token = ${lease.token}::uuid AND status = 'RUNNING'`;
    if (n === 0) throw new LeaseLostError(lease.runId);
  }

  async complete(lease: Lease): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.fenced(tx, lease, {
        status: 'COMPLETED',
        leaseToken: null,
        leaseUntil: null,
      });
      await appendRunEvent(tx, lease.runId, 'COMPLETED');
    });
  }

  async fail(lease: Lease, error: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.fenced(tx, lease, {
        status: 'FAILED',
        leaseToken: null,
        leaseUntil: null,
        lastError: error,
      });
      await appendRunEvent(tx, lease.runId, 'FAILED', { error });
    });
  }

  async scheduleRetry(
    lease: Lease,
    error: string,
    delaySeconds: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE runs SET status = 'PENDING', lease_token = NULL,
               lease_until = now() + make_interval(secs => ${delaySeconds}::float8),
               last_error = ${error}, updated_at = now()
         WHERE id = ${lease.runId}::uuid AND lease_token = ${lease.token}::uuid AND status = 'RUNNING'`;
      if (n === 0) throw new LeaseLostError(lease.runId);
      await appendRunEvent(tx, lease.runId, 'RETRY_SCHEDULED', {
        error,
        delaySeconds,
      });
    });
  }

  /** request_approval: release the worker (I5). */
  async toWaitingApproval(db: Db, lease: Lease): Promise<void> {
    await this.fenced(db, lease, {
      status: 'WAITING_APPROVAL',
      leaseToken: null,
      leaseUntil: null,
      attempts: 0,
    });
  }

  /** Human decision recorded: make the run claimable again. False if it was not waiting. */
  async resumeFromDecision(db: Db, runId: string): Promise<boolean> {
    const { count } = await db.run.updateMany({
      where: { id: runId, status: 'WAITING_APPROVAL' },
      data: {
        status: 'PENDING',
        attempts: 0,
        leaseUntil: null,
        leaseToken: null,
      },
    });
    return count === 1;
  }

  /** Expiry: make a waiting run expired. False if it was not waiting (accepted exception to convention 0001; a waiting run holds no lease). */
  async expireWaiting(db: Db, runId: string): Promise<boolean> {
    const { count } = await db.run.updateMany({
      where: { id: runId, status: 'WAITING_APPROVAL' },
      data: { status: 'EXPIRED', leaseToken: null, leaseUntil: null },
    });
    return count === 1;
  }

  /** Guarded write by the lease holder (convention 0001). */
  protected async fenced(
    db: Db,
    lease: Lease,
    data: Prisma.RunUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await db.run.updateMany({
      where: { id: lease.runId, leaseToken: lease.token, status: 'RUNNING' },
      data,
    });
    if (count === 0) throw new LeaseLostError(lease.runId);
  }
}
