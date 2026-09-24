import { randomUUID } from 'node:crypto';

export function replyPayload(p: {
  threadId: string | null;
  from: string;
  text: string;
  subject?: string;
  messageId?: string;
}) {
  return {
    event_type: 'message.received',
    message: {
      message_id: p.messageId ?? `<in-${randomUUID()}@fake>`,
      thread_id: p.threadId ?? undefined,
      from: p.from,
      subject: p.subject ?? 'Re: reembolso',
      text: p.text,
      extracted_text: p.text,
    },
  };
}
