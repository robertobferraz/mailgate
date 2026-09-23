import { PrismaClient } from '../../src/generated/prisma/client';
import { LeaseLostError } from '../../src/runs/run';
import { RunRepository } from '../../src/runs/run.repository';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

describe('RunRepository lease', () => {
  let prisma: PrismaClient;
  let repo: RunRepository;
  beforeAll(() => {
    prisma = newPrisma();
    repo = new RunRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('claims the oldest PENDING run with a fresh token', async () => {
    const a = await repo.create(validInput());
    await repo.create(validInput());
    const c = await repo.claim(60);
    expect(c?.run.id).toBe(a.id);
    expect(c?.run.status).toBe('RUNNING');
    expect(c?.run.attempts).toBe(1);
    expect(c?.lease.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(c?.reclaimed).toBe(false);
    expect(
      await prisma.runEvent.count({ where: { runId: a.id, type: 'CLAIMED' } }),
    ).toBe(1);
  });

  it('returns null when nothing is claimable', async () => {
    expect(await repo.claim(60)).toBeNull();
  });

  it('skips PENDING runs whose backoff (lease_until) is in the future', async () => {
    const r = await repo.create(validInput());
    await prisma.$executeRaw`UPDATE runs SET lease_until = now() + interval '1 hour' WHERE id = ${r.id}::uuid`;
    expect(await repo.claim(60)).toBeNull();
  });

  it('reclaims a RUNNING run whose lease expired, with a new token, and fences the old holder', async () => {
    await repo.create(validInput());
    const first = (await repo.claim(60))!;
    await prisma.$executeRaw`UPDATE runs SET lease_until = now() - interval '1 second' WHERE id = ${first.run.id}::uuid`;
    const second = (await repo.claim(60))!;
    expect(second.run.id).toBe(first.run.id);
    expect(second.reclaimed).toBe(true);
    expect(second.lease.token).not.toBe(first.lease.token);
    expect(second.run.attempts).toBe(2);
    expect(
      await prisma.runEvent.count({
        where: { runId: first.run.id, type: 'LEASE_LOST' },
      }),
    ).toBe(1);

    // zombie writes with the old token are rejected and change nothing
    await expect(
      repo.saveMessages(first.lease, [{ role: 'user', content: 'zombie' }], 60),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(repo.complete(first.lease)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    const row = await prisma.run.findUniqueOrThrow({
      where: { id: first.run.id },
    });
    expect(row.messages).toEqual([]);
    expect(row.status).toBe('RUNNING');
  });

  it('saveMessages renews the lease', async () => {
    await repo.create(validInput());
    const c = (await repo.claim(1))!;
    await repo.saveMessages(c.lease, [{ role: 'user', content: 'hi' }], 300);
    const [{ secs }] = await prisma.$queryRaw<{ secs: number }[]>`
      SELECT EXTRACT(EPOCH FROM (lease_until - now()))::float8 AS secs FROM runs WHERE id = ${c.run.id}::uuid`;
    expect(secs).toBeGreaterThan(250);
  });

  it('complete / fail / scheduleRetry transition with events', async () => {
    await repo.create(validInput());
    await repo.create(validInput());
    await repo.create(validInput());
    const a = (await repo.claim(60))!;
    await repo.complete(a.lease);
    const b = (await repo.claim(60))!;
    await repo.fail(b.lease, 'boom');
    const c = (await repo.claim(60))!;
    await repo.scheduleRetry(c.lease, 'rate limited', 30);

    const [ra, rb, rc] = await Promise.all(
      [a, b, c].map((x) =>
        prisma.run.findUniqueOrThrow({ where: { id: x.run.id } }),
      ),
    );
    expect(ra).toMatchObject({
      status: 'COMPLETED',
      leaseToken: null,
      leaseUntil: null,
    });
    expect(rb).toMatchObject({
      status: 'FAILED',
      lastError: 'boom',
      leaseToken: null,
    });
    expect(rc).toMatchObject({
      status: 'PENDING',
      lastError: 'rate limited',
      leaseToken: null,
    });
    expect(rc.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(
      await prisma.runEvent.count({
        where: { type: { in: ['COMPLETED', 'FAILED', 'RETRY_SCHEDULED'] } },
      }),
    ).toBe(3);
  });
});
