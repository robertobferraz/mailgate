import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config';
import { AgentMailProvider } from '../mail/agentmail.provider';
import type {
  InboundEvent,
  MailProvider,
  ReplyParams,
  SendParams,
} from '../mail/mail-provider';

export interface DemoSent {
  to: string;
  subject: string;
  threadId: string;
  messageId: string;
}

/** Outgoing mail stays in memory; inbound is verified by the real AgentMail/svix path (adr 0012). */
export class DemoMailProvider implements MailProvider {
  private readonly logger = new Logger('DemoMail');
  private readonly inbound: AgentMailProvider;
  readonly sent: DemoSent[] = [];
  private readonly byKey = new Map<
    string,
    { messageId: string; threadId: string }
  >();

  constructor(cfg: AppConfig) {
    this.inbound = new AgentMailProvider(cfg);
  }

  send(p: SendParams): Promise<{ messageId: string; threadId: string }> {
    const prior = this.byKey.get(p.idempotencyKey);
    if (prior) return Promise.resolve(prior);
    const r = {
      messageId: `<demo-${randomUUID()}@mailgate>`,
      threadId: `thr_demo_${randomUUID()}`,
    };
    this.byKey.set(p.idempotencyKey, r);
    this.sent.push({ to: p.to, subject: p.subject, ...r });
    this.logger.log(`→ ${p.to} · ${p.subject}`);
    return Promise.resolve(r);
  }

  reply(p: ReplyParams): Promise<{ messageId: string }> {
    this.logger.log(`↩ reply (${p.idempotencyKey}): ${p.text.split('\n')[0]}`);
    return Promise.resolve({ messageId: `<demo-r-${randomUUID()}@mailgate>` });
  }

  parseInbound(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): InboundEvent {
    return this.inbound.parseInbound(rawBody, headers);
  }
}
