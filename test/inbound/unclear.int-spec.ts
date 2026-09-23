import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('UNCLEAR replies', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('sends exactly one clarification in-thread, then ignores further UNCLEAR replies', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver(
      'evt_u1',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'hmm, qual projeto?',
        messageId: '<in-1@fake>',
      }),
    );
    await h.deliver(
      'evt_u2',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'talvez',
        messageId: '<in-2@fake>',
      }),
    );
    await h.inbound.processNext();
    await h.inbound.processNext();

    expect(h.mail.replies).toHaveLength(1);
    expect(h.mail.replies[0]).toMatchObject({
      messageId: '<in-1@fake>',
      idempotencyKey: `clarify-${approval.id}`,
    });
    expect(h.mail.replies[0].text).toContain(
      'Responda apenas APROVO ou RECUSO',
    );
    expect(
      await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: approval.id },
      }),
    ).toMatchObject({ status: 'SENT', clarificationSent: true });
    const outcomes = await prisma.inboundEvent.findMany({
      orderBy: { receivedAt: 'asc' },
    });
    expect(outcomes.map((o) => o.outcome)).toEqual([
      'CLARIFICATION_SENT',
      'IGNORED_UNCLEAR',
    ]);
  });

  it('keeps the event pending when the clarification send fails, and retries after the lease', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    h.mail.failNextReplies = 1;
    await h.deliver(
      'evt_u3',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'hmm',
      }),
    );
    await h.inbound.processNext();
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({
        where: { providerEventId: 'evt_u3' },
      }),
    ).toMatchObject({ outcome: null, lastError: 'fake: provider unavailable' });
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).clarificationSent,
    ).toBe(false);

    await prisma.$executeRaw`UPDATE inbound_events SET lease_until = now() - interval '1 second'`;
    await h.inbound.processNext();
    expect(h.mail.replies).toHaveLength(1);
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'evt_u3' },
        })
      ).outcome,
    ).toBe('CLARIFICATION_SENT');
  });
});
