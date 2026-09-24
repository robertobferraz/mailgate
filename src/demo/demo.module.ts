import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { DemoController } from './demo.controller';

/**
 * A plain, statically-registered module — NOT `DemoModule.register()` gated
 * on `loadConfig().DEMO`. A dynamic module's controllers array is decided
 * when app.module.ts is first imported, which happens before an int test's
 * `beforeAll` can set process.env.DEMO, so it would never register the
 * controller under test. Registering unconditionally and gating inside
 * DemoController (404 unless MAIL_PROVIDER is a DemoMailProvider) works in
 * both real boot and tests, regardless of when DEMO was set.
 */
@Module({ imports: [MailModule], controllers: [DemoController] })
export class DemoModule {}
