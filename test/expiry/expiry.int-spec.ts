import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness, sentApproval } from '../helpers/harness';

const pastDue = (prisma: PrismaClient, id: string) =>
  prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ${id}::uuid`;

describe('ExpiryService', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('expires a SENT request past expires_at and its run; the run never acts', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await pastDue(prisma, approval.id);

    expect(await h.expiry.expireDue()).toBe(1);
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status,
    ).toBe('EXPIRED');
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status,
    ).toBe('EXPIRED');
    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'EXPIRED' },
      }),
    ).toBe(1);
    expect(await h.runs.claim(60)).toBeNull();
    expect(await prisma.action.count({ where: { runId: run.id } })).toBe(0);
  });

  it('expires a CREATED request whose send never succeeded', async () => {
    const h = buildHarness(prisma);
    h.llm.push(
      toolUse('request_approval', {
        summary: 's',
        recommendation: 'APPROVE',
        rationale: 'r',
      }),
    );
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    const a = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id },
    });
    await pastDue(prisma, a.id);
    await h.expiry.expireDue();
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status,
    ).toBe('EXPIRED');
  });

  it('leaves requests that are not yet due', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    expect(await h.expiry.expireDue()).toBe(0);
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status,
    ).toBe('SENT');
  });

  it('ignores a reply arriving after expiry', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await pastDue(prisma, approval.id);
    await h.expiry.expireDue();
    await h.deliver(
      'evt_late',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'aprovo',
      }),
    );
    await h.inbound.processNext();
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'evt_late' },
        })
      ).outcome,
    ).toBe('IGNORED_EXPIRED');
  });

  it('ignores a reply that arrives after expires_at even before the expiry job runs', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = ${approval.id}::uuid`;
    await h.deliver(
      'evt_late',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'aprovo',
      }),
    );
    await h.inbound.processNext();

    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'evt_late' },
        })
      ).outcome,
    ).toBe('IGNORED_EXPIRED');
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status,
    ).toBe('SENT');
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status,
    ).toBe('WAITING_APPROVAL');
  });

  it('drains more than one batch in a single expireDue call', async () => {
    const h = buildHarness(prisma);
    for (let i = 0; i < 55; i++) {
      const r = await h.runs.create(validInput());
      await prisma.run.update({
        where: { id: r.id },
        data: { status: 'WAITING_APPROVAL' },
      });
      await h.approvals.createIfAbsent(prisma, {
        runId: r.id,
        toolUseId: `toolu_${i}`,
        approverEmail: 'gestor@acme.test',
        summary: 's',
        recommendation: 'APPROVE',
        rationale: 'r',
        ttlHours: 1,
      });
    }
    await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 minute'`;

    expect(await h.expiry.expireDue()).toBe(55);
    expect(
      await prisma.approvalRequest.count({ where: { status: 'EXPIRED' } }),
    ).toBe(55);
  });
});
