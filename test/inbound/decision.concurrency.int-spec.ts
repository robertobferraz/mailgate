import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('I2 — an approval request receives at most one decision', () => {
  let seed: PrismaClient;
  const clients: PrismaClient[] = [];
  beforeAll(() => {
    seed = newPrisma();
  });
  afterAll(async () => {
    await Promise.all([seed, ...clients].map((c) => c.$disconnect()));
  });
  beforeEach(() => truncateAll(seed));

  it('two different replies processed in parallel produce exactly one decision', async () => {
    const h = buildHarness(seed);
    const { run, approval } = await sentApproval(h, seed);
    await h.deliver(
      'evt_a',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'aprovo',
      }),
    );
    await h.deliver(
      'evt_r',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'recuso',
      }),
    );

    const processors = [0, 1].map(() => {
      const c = newPrisma(3);
      clients.push(c);
      return buildHarness(c, { classifierDelayMs: 30 }).inbound; // both pass the pre-check, then race on FOR UPDATE
    });
    await Promise.all(processors.map((p) => p.processNext()));

    const outcomes = (await seed.inboundEvent.findMany())
      .map((e) => e.outcome)
      .sort();
    expect(outcomes).toEqual(['IGNORED_ALREADY_DECIDED', 'PROCESSED']);
    expect(
      (
        await seed.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status,
    ).toBe('DECIDED');
    expect(
      await seed.runEvent.count({
        where: { runId: run.id, type: 'DECISION_RECEIVED' },
      }),
    ).toBe(1);
    expect(
      (await seed.run.findUniqueOrThrow({ where: { id: run.id } })).status,
    ).toBe('PENDING');
  });
});
