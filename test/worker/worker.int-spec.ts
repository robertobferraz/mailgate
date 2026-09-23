import { PrismaClient } from '../../src/generated/prisma/client';
import { RunRepository } from '../../src/runs/run.repository';
import { AgentStep, StubAgentStep } from '../../src/worker/agent-step';
import { PermanentError } from '../../src/worker/errors';
import { WorkerService } from '../../src/worker/worker.service';
import { testConfig } from '../helpers/config';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

describe('WorkerService', () => {
  let prisma: PrismaClient;
  let runs: RunRepository;
  beforeAll(() => {
    prisma = newPrisma();
    runs = new RunRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  const worker = (agent: AgentStep, cfg: Record<string, string> = {}) =>
    new WorkerService(testConfig(cfg), runs, agent);
  const throwing = (e: Error): AgentStep => ({
    run: () => Promise.reject(e),
  });

  it('processes a PENDING run with the stub to COMPLETED', async () => {
    const r = await runs.create(validInput());
    expect(await worker(new StubAgentStep(runs)).processNextRun()).toBe(true);
    expect((await runs.findById(r.id))?.status).toBe('COMPLETED');
    expect(await worker(new StubAgentStep(runs)).processNextRun()).toBe(false);
  });

  it('schedules a retry with backoff on a transient error', async () => {
    const r = await runs.create(validInput());
    await worker(throwing(new Error('socket hang up'))).processNextRun();
    const row = await prisma.run.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({
      status: 'PENDING',
      lastError: 'socket hang up',
      attempts: 1,
    });
    expect(row.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('fails the run on a permanent error', async () => {
    const r = await runs.create(validInput());
    await worker(throwing(new PermanentError('bad input'))).processNextRun();
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: r.id } }),
    ).toMatchObject({ status: 'FAILED', lastError: 'bad input' });
  });

  it('fails the run once attempts exceed MAX_ATTEMPTS, without calling the agent', async () => {
    const r = await runs.create(validInput());
    await prisma.$executeRaw`UPDATE runs SET attempts = 2, last_error = 'previous' WHERE id = ${r.id}::uuid`;
    const agent = { run: jest.fn() };
    await worker(agent, { MAX_ATTEMPTS: '2' }).processNextRun();
    expect(agent.run).not.toHaveBeenCalled();
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: r.id } }),
    ).toMatchObject({
      status: 'FAILED',
      lastError: 'max attempts exceeded: previous',
    });
  });
});
