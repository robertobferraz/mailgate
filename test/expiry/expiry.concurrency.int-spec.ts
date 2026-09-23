import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('decision × expiry race — exactly one wins', () => {
  let seed: PrismaClient;
  const clients: PrismaClient[] = [];
  beforeAll(() => {
    seed = newPrisma();
  });
  afterAll(async () => {
    await Promise.all([seed, ...clients].map((c) => c.$disconnect()));
  });
  beforeEach(() => truncateAll(seed));

  it.each([0, 5, 20])('classifier delay %ims', async (delay) => {
    const h = buildHarness(seed);
    const { run, approval } = await sentApproval(h, seed);
    await h.deliver(
      'evt_race',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'aprovo',
      }),
    );
    await seed.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = ${approval.id}::uuid`;

    const [c1, c2] = [newPrisma(3), newPrisma(3)];
    clients.push(c1, c2);
    const decider = buildHarness(c1, { classifierDelayMs: delay }).inbound;
    const expirer = buildHarness(c2).expiry;
    await Promise.all([decider.processNext(), expirer.expireDue()]);
    await buildHarness(seed).expiry.expireDue(); // a SKIP LOCKED pass may have skipped the row; the next tick picks it up

    const a = await seed.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
    });
    const r = await seed.run.findUniqueOrThrow({ where: { id: run.id } });
    const decided = a.status === 'DECIDED' && r.status === 'PENDING';
    const expired = a.status === 'EXPIRED' && r.status === 'EXPIRED';
    expect(decided !== expired).toBe(true);
    expect(
      await seed.runEvent.count({
        where: {
          runId: run.id,
          type: { in: ['DECISION_RECEIVED', 'EXPIRED'] },
        },
      }),
    ).toBe(1);
  });
});
