import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import {
  InboundEvent,
  InvalidSignatureError,
  MAIL_PROVIDER,
} from '../mail/mail-provider';
import type { MailProvider } from '../mail/mail-provider';
import { InboundEventRepository } from './inbound-event.repository';

/** Stores events only; the worker's InboundProcessor decides (D014). */
@Controller('webhooks')
export class WebhookController {
  constructor(
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    private readonly events: InboundEventRepository,
  ) {}

  @Post('mail')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ): Promise<{ received: true; stored: boolean }> {
    if (!req.rawBody) throw new BadRequestException('raw body required');
    let event: InboundEvent;
    try {
      event = this.mail.parseInbound(req.rawBody, headers);
    } catch (e) {
      if (e instanceof InvalidSignatureError) throw new UnauthorizedException();
      throw e;
    }
    if (event.type !== 'message.received')
      return { received: true, stored: false };
    return { received: true, stored: await this.events.insertIfAbsent(event) };
  }
}
