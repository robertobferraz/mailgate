import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/config';

async function bootstrap(): Promise<void> {
  // rawBody is required for Svix signature verification on /webhooks/mail
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  const cfg = app.get<AppConfig>(APP_CONFIG);
  await app.listen(cfg.PORT);
}
void bootstrap();
