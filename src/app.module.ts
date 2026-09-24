import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DemoModule } from './demo/demo.module';
import { DatabaseModule } from './prisma/database.module';
import { HealthModule } from './health/health.module';
import { InboundModule } from './inbound/inbound.module';
import { RunsModule } from './runs/runs.module';
import { WorkerModule } from './worker/worker.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    DemoModule,
    HealthModule,
    InboundModule,
    RunsModule,
    WorkerModule,
  ],
})
export class AppModule {}
