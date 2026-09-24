import { Controller, Get, Inject, NotFoundException } from '@nestjs/common';
import { MAIL_PROVIDER } from '../mail/mail-provider';
import type { MailProvider } from '../mail/mail-provider';
import { DemoMailProvider, DemoSent } from './demo-mail.provider';

/**
 * Always registered in AppModule (see demo.module.ts for why), but only
 * ever useful when DEMO=true: MailModule only ever binds MAIL_PROVIDER to
 * a DemoMailProvider when cfg.DEMO is set, so outside DEMO this 404s.
 */
@Controller('demo')
export class DemoController {
  constructor(@Inject(MAIL_PROVIDER) private readonly mail: MailProvider) {}

  @Get('outbox')
  outbox(): { sent: DemoSent[] } {
    if (!(this.mail instanceof DemoMailProvider)) {
      throw new NotFoundException();
    }
    return { sent: this.mail.sent };
  }
}
