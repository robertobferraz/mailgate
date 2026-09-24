import type { LlmClient, LlmRequest } from '../../src/agent/llm-client';
import type Anthropic from '@anthropic-ai/sdk';
import { AgentRunner } from '../../src/agent/agent-runner';
import { PrismaClient } from '../../src/generated/prisma/client';
import { WorkerService } from '../../src/worker/worker.service';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness } from '../helpers/harness';

/** Hangs until its request signal aborts, like the Anthropic SDK does. */
class HangingLlm implements LlmClient {
  createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    return new Promise((_, reject) => {
      req.signal?.addEventListener('abort', () =>
        reject(new Error('Request was aborted.')),
      );
    });
  }
}

describe('shutdown abort', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('releases the run to PENDING and gives the attempt back', async () => {
    const h = buildHarness(prisma);
    const agent = new AgentRunner(
      h.cfg,
      prisma,
      h.runs,
      h.approvals,
      h.actions,
      new HangingLlm(),
    );
    const worker = new WorkerService(h.cfg, h.runs, agent);
    const run = await h.runs.create(validInput());

    const processing = worker.processNextRun();
    await new Promise((r) => setTimeout(r, 200));
    worker.abortInFlight();
    await processing;

    const after = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
    });
    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'RELEASED' },
      }),
    ).toBe(1);
  });
});
