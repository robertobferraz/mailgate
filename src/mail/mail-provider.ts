export interface SendParams {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface ReplyParams {
  messageId: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface InboundEvent {
  eventId: string;
  type: string;
  threadId: string | null;
  messageId: string;
  from: string;
  subject: string;
  text: string;
  raw: unknown;
}

export interface MailProvider {
  send(p: SendParams): Promise<{ messageId: string; threadId: string }>;
  reply(p: ReplyParams): Promise<{ messageId: string }>;
  /** Verifies the signature; throws InvalidSignatureError. */
  parseInbound(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): InboundEvent;
}

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

export class InvalidSignatureError extends Error {
  constructor(message = 'invalid webhook signature') {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

/** "Nome <E@X>" -> "e@x" */
export function extractAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

type Loose = Record<string, unknown> | undefined;

export function toInboundEvent(eventId: string, body: unknown): InboundEvent {
  const b = (body ?? {}) as Record<string, unknown>;
  const m = (b.message ?? {}) as Record<string, unknown>;
  const thread = b.thread as Loose;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    eventId,
    type: str(b.event_type) || str(b.type),
    threadId: str(m.thread_id) || str(thread?.thread_id) || null,
    messageId: str(m.message_id),
    from: extractAddress(str(m.from)),
    subject: str(m.subject),
    text: str(m.extracted_text) || str(m.text),
    raw: body,
  };
}
