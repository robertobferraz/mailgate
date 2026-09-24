import { randomUUID } from 'node:crypto';
import {
  InboundEvent,
  InvalidSignatureError,
  MailProvider,
  ReplyParams,
  SendParams,
  toInboundEvent,
} from '../../src/mail/mail-provider';

/** In-memory provider with idempotency-key semantics like AgentMail (same key -> same result, no second delivery). */
export class FakeMailProvider implements MailProvider {
  readonly sent: SendParams[] = [];
  readonly replies: ReplyParams[] = [];
  failNextSends = 0;
  failNextReplies = 0;
  private readonly sendByKey = new Map<
    string,
    { messageId: string; threadId: string }
  >();
  private readonly replyByKey = new Map<string, { messageId: string }>();

  // eslint-disable-next-line @typescript-eslint/require-await -- async on purpose: throws must reject the returned promise, not throw synchronously
  async send(p: SendParams): Promise<{ messageId: string; threadId: string }> {
    if (this.failNextSends > 0) {
      this.failNextSends--;
      throw new Error('fake: provider unavailable');
    }
    const prior = this.sendByKey.get(p.idempotencyKey);
    if (prior) return prior;
    this.sent.push(p);
    const r = {
      messageId: `<m-${randomUUID()}@fake>`,
      threadId: `thr_${randomUUID()}`,
    };
    this.sendByKey.set(p.idempotencyKey, r);
    return r;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async on purpose: throws must reject the returned promise, not throw synchronously
  async reply(p: ReplyParams): Promise<{ messageId: string }> {
    if (this.failNextReplies > 0) {
      this.failNextReplies--;
      throw new Error('fake: provider unavailable');
    }
    const prior = this.replyByKey.get(p.idempotencyKey);
    if (prior) return prior;
    this.replies.push(p);
    const r = { messageId: `<r-${randomUUID()}@fake>` };
    this.replyByKey.set(p.idempotencyKey, r);
    return r;
  }

  deliveredSendKeys(): string[] {
    return this.sent.map((s) => s.idempotencyKey);
  }

  parseInbound(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): InboundEvent {
    if (headers['x-fake-signature'] !== 'valid')
      throw new InvalidSignatureError();
    return toInboundEvent(
      String(headers['svix-id']),
      JSON.parse(rawBody.toString('utf8')),
    );
  }

  /** Headers + body for a signed webhook request in HTTP tests. */
  static signedRequest(eventId: string, body: unknown) {
    return {
      headers: {
        'svix-id': eventId,
        'x-fake-signature': 'valid',
        'content-type': 'application/json',
      },
      body,
    };
  }
}

export { replyPayload } from '../../src/demo/reply-payload';
