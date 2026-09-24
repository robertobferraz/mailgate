import { PrismaClient } from '../../src/generated/prisma/client';
import { newPrisma, truncateAll } from '../helpers/db';

describe('f6 schema', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('accepts the new inbound outcomes', async () => {
    for (const outcome of ['IGNORED_EXPIRED', 'FAILED']) {
      await prisma.inboundEvent.create({
        data: { providerEventId: `e_${outcome}`, payload: {}, outcome },
      });
    }
    expect(await prisma.inboundEvent.count()).toBe(2);
  });

  it('rejects an unknown outcome', async () => {
    await expect(
      prisma.inboundEvent.create({
        data: { providerEventId: 'e_x', payload: {}, outcome: 'NOPE' },
      }),
    ).rejects.toThrow();
  });

  it('has the new approval columns with defaults', async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'approval_requests'`;
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'late_reply_sent',
        'decided_at',
        'send_attempts',
        'next_send_at',
        'send_lease_until',
      ]),
    );
  });
});
