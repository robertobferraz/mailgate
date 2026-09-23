import { PrismaClient } from '../../src/generated/prisma/client';
import { RunRepository } from '../../src/runs/run.repository';
import { WorkerService } from '../../src/worker/worker.service';
import { testConfig } from '../helpers/config';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('I4 — at most one worker processes a run at a time', () => {
  const clients: PrismaClient[] = [];
  let seed: PrismaClient;
  beforeAll(() => {
    seed = newPrisma();
  });
  afterAll(async () => {
    await Promise.all([seed, ...clients].map((c) => c.$disconnect()));
  });
  beforeEach(() => truncateAll(seed));

  it('5 parallel workers over 40 runs process each run exactly once', async () => {
    const seedRepo = new RunRepository(seed);
    for (let i = 0; i < 40; i++) await seedRepo.create(validInput());

    const processed: string[] = [];
    const workers = Array.from({ length: 5 }, () => {
      const client = newPrisma(3);
      clients.push(client);
      const repo = new RunRepository(client);
      return new WorkerService(testConfig(), repo, {
        run: async (run, lease) => {
          processed.push(run.id);
          await sleep(5);
          await repo.complete(lease);
        },
      });
    });

    await Promise.all(
      workers.map(async (w) => {
        while (await w.processNextRun()) {
          /* drain */
        }
      }),
    );

    expect(processed).toHaveLength(40);
    expect(new Set(processed).size).toBe(40);
    expect(
      await seed.run.count({ where: { status: 'COMPLETED', attempts: 1 } }),
    ).toBe(40);
  });
});
