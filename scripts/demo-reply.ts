/* Signs a demo reply with the svix secret and posts it (adr 0012). Usage: ts-node scripts/demo-reply.ts "pode aprovar" */
import { randomUUID } from 'node:crypto';
import { Webhook } from 'svix';
import { replyPayload } from '../src/demo/reply-payload';

async function main(): Promise<void> {
  const base = process.env.API_URL ?? 'http://localhost:3000';
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret) throw new Error('AGENTMAIL_WEBHOOK_SECRET is required');
  const text = process.argv[2] ?? 'pode aprovar';
  const from = process.env.DEMO_APPROVER ?? 'gestor@acme.test';

  const outbox = (await (await fetch(`${base}/demo/outbox`)).json()) as {
    sent: { threadId: string; subject: string }[];
  };
  const last = outbox.sent.at(-1);
  if (!last) throw new Error('no approval e-mail in the demo outbox yet');

  const body = JSON.stringify(
    replyPayload({
      threadId: last.threadId,
      from,
      text,
      subject: `Re: ${last.subject}`,
    }),
  );
  const id = `msg_${randomUUID()}`;
  const now = new Date();
  const res = await fetch(`${base}/webhooks/mail`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
      'svix-signature': new Webhook(secret).sign(id, now, body),
    },
    body,
  });
  console.log(`reply "${text}" → ${res.status}`);
  if (!res.ok) {
    throw new Error(`webhook POST failed with status ${res.status}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
