import { Inject, Injectable } from '@nestjs/common';
import { AgentMailClient } from 'agentmail';
import { Webhook } from 'svix';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import {
  InboundEvent,
  InvalidSignatureError,
  MailProvider,
  ReplyParams,
  SendParams,
  toInboundEvent,
} from './mail-provider';

const header = (
  h: Record<string, string | string[] | undefined>,
  k: string,
) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

@Injectable()
export class AgentMailProvider implements MailProvider {
  private readonly client: AgentMailClient;
  private readonly webhook: Webhook | null;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.client = new AgentMailClient({ apiKey: cfg.AGENTMAIL_API_KEY ?? '' });
    this.webhook = cfg.AGENTMAIL_WEBHOOK_SECRET
      ? new Webhook(cfg.AGENTMAIL_WEBHOOK_SECRET)
      : null;
  }

  private inbox(): string {
    if (!this.cfg.AGENTMAIL_INBOX_ID) {
      throw new Error('AGENTMAIL_INBOX_ID not configured');
    }
    return this.cfg.AGENTMAIL_INBOX_ID;
  }

  async send(p: SendParams): Promise<{ messageId: string; threadId: string }> {
    const res = await this.client.inboxes.messages.send(
      this.inbox(),
      { to: p.to, subject: p.subject, text: p.text, html: p.html },
      { idempotencyKey: p.idempotencyKey },
    );
    return { messageId: res.messageId, threadId: res.threadId };
  }

  async reply(p: ReplyParams): Promise<{ messageId: string }> {
    const res = await this.client.inboxes.messages.reply(
      this.inbox(),
      p.messageId,
      { text: p.text, html: p.html },
      { idempotencyKey: p.idempotencyKey },
    );
    return { messageId: res.messageId };
  }

  parseInbound(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): InboundEvent {
    if (!this.webhook) {
      throw new InvalidSignatureError('webhook secret not configured');
    }
    const svix = {
      'svix-id': header(headers, 'svix-id') ?? '',
      'svix-timestamp': header(headers, 'svix-timestamp') ?? '',
      'svix-signature': header(headers, 'svix-signature') ?? '',
    };
    const raw = rawBody.toString('utf8');
    try {
      this.webhook.verify(raw, svix);
    } catch {
      throw new InvalidSignatureError();
    }
    const body: unknown = JSON.parse(raw);
    return toInboundEvent(svix['svix-id'], body);
  }
}
