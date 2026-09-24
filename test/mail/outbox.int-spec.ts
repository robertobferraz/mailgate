import { PrismaClient } from '../../src/generated/prisma/client';
import { OutboxService } from '../../src/mail/outbox.service';
import { toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness } from '../helpers/harness';

const ASK = {
  summary: 'Hotel 2 diárias',
  recommendation: 'APPROVE',
  rationale: 'dentro da média',
};

describe('OutboxService', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  async function pausedRun(h: ReturnType<typeof buildHarness>) {
    h.llm.push(toolUse('request_approval', ASK));
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    return run;
  }

  it('sends the approval e-mail with the idempotency key and marks SENT', async () => {
    const h = buildHarness(prisma);
    const run = await pausedRun(h);
    expect(await h.outbox.dispatch()).toBe(1);

    const a = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id },
    });
    expect(a).toMatchObject({ status: 'SENT', lastError: null });
    expect(a.providerThreadId).toMatch(/^thr_/);
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]).toMatchObject({
      to: 'gestor@acme.test',
      idempotencyKey: `approval-${a.id}`,
    });
    expect(h.mail.sent[0].subject).toBe(
      `[mailgate #${a.subjectToken}] Reembolso de R$ 840,00 — aprovação necessária`,
    );
    expect(h.mail.sent[0].text).toContain(
      'Responda este e-mail com APROVO ou RECUSO',
    );
    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'APPROVAL_SENT' },
      }),
    ).toBe(1);
    expect(await h.outbox.dispatch()).toBe(0);
  });

  it('keeps CREATED with last_error when sending fails, and sends on the next dispatch', async () => {
    const h = buildHarness(prisma);
    const run = await pausedRun(h);
    h.mail.failNextSends = 1;
    expect(await h.outbox.dispatch()).toBe(0);
    expect(
      await prisma.approvalRequest.findFirstOrThrow({
        where: { runId: run.id },
      }),
    ).toMatchObject({
      status: 'CREATED',
      lastError: 'fake: provider unavailable',
    });

    await prisma.$executeRaw`UPDATE approval_requests SET next_send_at = now() - interval '1 second'`;
    expect(await h.outbox.dispatch()).toBe(1);
    expect(
      (
        await prisma.approvalRequest.findFirstOrThrow({
          where: { runId: run.id },
        })
      ).status,
    ).toBe('SENT');
  });

  it('backs off after a failure: not retried before next_send_at', async () => {
    const h = buildHarness(prisma);
    const run = await pausedRun(h);
    h.mail.failNextSends = 1;
    await h.outbox.dispatch();
    const [row] = await prisma.$queryRaw<
      { send_attempts: number; secs: number }[]
    >`
      SELECT send_attempts, EXTRACT(EPOCH FROM next_send_at - now())::float8 AS secs
        FROM approval_requests WHERE run_id = ${run.id}::uuid`;
    expect(row.send_attempts).toBe(1);
    expect(row.secs).toBeGreaterThan(25);
    expect(row.secs).toBeLessThanOrEqual(30);
    expect(await h.outbox.dispatch()).toBe(0);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('caps the backoff at one hour', async () => {
    const h = buildHarness(prisma);
    const run = await pausedRun(h);
    await prisma.$executeRaw`UPDATE approval_requests SET send_attempts = 12 WHERE run_id = ${run.id}::uuid`;
    h.mail.failNextSends = 1;
    await h.outbox.dispatch();
    const [row] = await prisma.$queryRaw<{ secs: number }[]>`
      SELECT EXTRACT(EPOCH FROM next_send_at - now())::float8 AS secs FROM approval_requests WHERE run_id = ${run.id}::uuid`;
    expect(row.secs).toBeGreaterThan(3590);
    expect(row.secs).toBeLessThanOrEqual(3600);
  });

  it('never sends a CREATED request whose deadline has passed', async () => {
    const h = buildHarness(prisma);
    await pausedRun(h);
    await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 second'`;
    expect(await h.outbox.dispatch()).toBe(0);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('expiry skips a row the outbox has reserved', async () => {
    const h = buildHarness(prisma);
    await pausedRun(h);
    await prisma.$executeRaw`UPDATE approval_requests SET send_lease_until = now() + interval '1 minute', expires_at = now() - interval '1 second'`;
    expect(await h.expiry.expireDue()).toBe(0);
  });

  it('a permanently failing older approval does not starve a newer one', async () => {
    const h = buildHarness(prisma, { cfg: { OUTBOX_BATCH: '1' } });
    const older = await pausedRun(h);
    h.mail.failNextSends = 1;
    expect(await h.outbox.dispatch()).toBe(0);
    expect(
      (
        await prisma.approvalRequest.findFirstOrThrow({
          where: { runId: older.id },
        })
      ).status,
    ).toBe('CREATED');

    const newer = await pausedRun(h);
    expect(await h.outbox.dispatch()).toBe(1);
    expect(
      (
        await prisma.approvalRequest.findFirstOrThrow({
          where: { runId: newer.id },
        })
      ).status,
    ).toBe('SENT');
  });

  it('stops before reserving the next row once shouldStop returns true', async () => {
    const h = buildHarness(prisma, { cfg: { OUTBOX_BATCH: '10' } });
    await pausedRun(h);
    await pausedRun(h);
    const shouldStop = jest.fn(() => true);
    expect(await h.outbox.dispatch(shouldStop)).toBe(0);
    expect(h.mail.sent).toHaveLength(0);
    expect(shouldStop).toHaveBeenCalled();
  });

  it('two concurrent dispatchers deliver one e-mail and mark SENT once', async () => {
    const h = buildHarness(prisma);
    await pausedRun(h);
    const other = new OutboxService(h.cfg, prisma, h.mail);
    await Promise.all([h.outbox.dispatch(), other.dispatch()]);
    expect(h.mail.deliveredSendKeys()).toHaveLength(1);
    expect(
      await prisma.runEvent.count({ where: { type: 'APPROVAL_SENT' } }),
    ).toBe(1);
  });
});
