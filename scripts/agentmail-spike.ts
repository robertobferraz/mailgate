import 'dotenv/config';
import { loadConfig } from '../src/config/config';
import { AgentMailProvider } from '../src/mail/agentmail.provider';

/** F3 spike (D005): confirms thread id and Idempotency-Key against the real API. */
async function main(): Promise<void> {
  const to = process.env.AGENTMAIL_SPIKE_TO;
  if (!to) throw new Error('set AGENTMAIL_SPIKE_TO');
  const provider = new AgentMailProvider(loadConfig());
  const key = `spike-${Date.now()}`;
  const p = {
    to,
    subject: '[mailgate spike] idempotency',
    text: 'spike',
    html: '<p>spike</p>',
    idempotencyKey: key,
  };
  const a = await provider.send(p);
  const b = await provider.send(p);
  console.log({
    first: a,
    second: b,
    idempotent: a.messageId === b.messageId && a.threadId === b.threadId,
  });
}
void main();
