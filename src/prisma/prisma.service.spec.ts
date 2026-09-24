import { PrismaService } from './prisma.service';

describe('PrismaService lifecycle', () => {
  it('disconnects in onApplicationShutdown, not in onModuleDestroy (adr 0008)', () => {
    const proto = PrismaService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.onApplicationShutdown).toBe('function');
    expect(proto.onModuleDestroy).toBeUndefined();
  });
});
