import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('late reply (pdr 0005)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  const reply = (
    threadId: string | null,
    text: string,
    from = 'gestor@acme.test',
  ) => replyPayload({ threadId, from, text });

  it('answers once in-thread when the request is already decided', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('e1', reply(approval.providerThreadId, 'aprovo'));
    await h.inbound.processNext();
    await h.deliver('e2', reply(approval.providerThreadId, 'aprovo de novo'));
    await h.deliver('e3', reply(approval.providerThreadId, 'e mais uma vez'));
    await h.inbound.processNext();
    await h.inbound.processNext();

    const late = h.mail.replies.filter(
      (r) => r.idempotencyKey === `late-${approval.id}`,
    );
    expect(late).toHaveLength(1);
    expect(late[0].text).toContain('Este pedido já foi APROVADO em');
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).lateReplySent,
    ).toBe(true);
    const outcomes = await prisma.inboundEvent.findMany({
      where: { providerEventId: { in: ['e2', 'e3'] } },
      select: { outcome: true },
    });
    expect(outcomes.map((o) => o.outcome)).toEqual([
      'IGNORED_ALREADY_DECIDED',
      'IGNORED_ALREADY_DECIDED',
    ]);
  });

  it('answers once when the request expired (even before the job ran)', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = ${approval.id}::uuid`;
    await h.deliver('e1', reply(approval.providerThreadId, 'aprovo'));
    await h.inbound.processNext();

    expect(h.mail.replies).toHaveLength(1);
    expect(h.mail.replies[0].text).toContain('Este pedido expirou em');
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'e1' },
        })
      ).outcome,
    ).toBe('IGNORED_EXPIRED');
  });

  it('does not answer another sender (I6)', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('e1', reply(approval.providerThreadId, 'aprovo'));
    await h.inbound.processNext();
    await h.deliver(
      'e2',
      reply(approval.providerThreadId, 'aprovo', 'intruso@evil.test'),
    );
    await h.inbound.processNext();
    expect(h.mail.replies).toHaveLength(0);
  });

  it('retries the late reply when sending fails, without sending twice', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('e1', reply(approval.providerThreadId, 'aprovo'));
    await h.inbound.processNext();
    h.mail.failNextReplies = 1;
    await h.deliver('e2', reply(approval.providerThreadId, 'aprovo?'));
    await h.inbound.processNext();
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'e2' },
        })
      ).outcome,
    ).toBeNull();
    await prisma.inboundEvent.update({
      where: { providerEventId: 'e2' },
      data: { leaseUntil: null },
    });
    await h.inbound.processNext();
    expect(h.mail.replies).toHaveLength(1);
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).lateReplySent,
    ).toBe(true);
  });
});
