import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
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
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
