import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

export async function createTestApp(
  configure: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<INestApplication> {
  process.env.WORKER_ENABLED = 'false';
  const moduleRef = await configure(
    Test.createTestingModule({ imports: [AppModule] }),
  ).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  return app;
}
