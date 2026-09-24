import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    // explicit pool: connectionTimeoutMillis defaults to 0 (wait forever) in pg (RESEARCH Q3)
    super({
      adapter: new PrismaPg({
        connectionString: cfg.DATABASE_URL,
        max: cfg.DB_POOL_MAX,
        connectionTimeoutMillis: 5000,
      }),
    });
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  // last shutdown phase: WorkerLoop drains in beforeApplicationShutdown first (adr 0008)
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
