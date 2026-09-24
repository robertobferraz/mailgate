import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Webhook } from 'svix';
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../../src/demo/reply-payload';
import { WorkerService } from '../../src/worker/worker.service';
import { OutboxService } from '../../src/mail/outbox.service';
import { InboundProcessor } from '../../src/inbound/inbound.processor';
import { createTestApp } from '../helpers/app';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

const SECRET = `whsec_${Buffer.from('mailgate-demo-secret-0123456789').toString('base64')}`;

describe('DEMO mode', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  beforeAll(async () => {
    process.env.DEMO = 'true';
    process.env.AGENTMAIL_WEBHOOK_SECRET = SECRET;
    prisma = newPrisma();
    app = await createTestApp();
  });
  afterAll(async () => {
    delete process.env.DEMO;
    delete process.env.AGENTMAIL_WEBHOOK_SECRET;
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(() => truncateAll(prisma));

  it('runs the whole approval flow with fakes and a real signed webhook', async () => {
    const http = request(app.getHttpServer() as App);
    const created = await http
      .post('/runs')
      .send(validInput({ amountCents: 84000 }))
      .expect(201);
    const body = created.body as unknown as { id: string };
    await app.get(WorkerService).processNextRun();
    await app.get(OutboxService).dispatch();

    const outboxRes = await http.get('/demo/outbox').expect(200);
    const outbox = outboxRes.body as unknown as {
      sent: { to: string; subject: string; threadId: string }[];
    };
    const sent = outbox.sent[0];
    const payload = JSON.stringify(
      replyPayload({
        threadId: sent.threadId,
        from: 'gestor@acme.test',
        text: 'pode aprovar',
        subject: `Re: ${sent.subject}`,
      }),
    );
    const msgId = 'msg_demo_1';
    const now = new Date();
    const signature = new Webhook(SECRET).sign(msgId, now, payload);
    await http
      .post('/webhooks/mail')
      .set('content-type', 'application/json')
      .set('svix-id', msgId)
      .set('svix-timestamp', String(Math.floor(now.getTime() / 1000)))
      .set('svix-signature', signature)
      .send(payload)
      .expect(200);

    await app.get(InboundProcessor).processNext();
    await app.get(WorkerService).processNextRun();
    const runRes = await http.get(`/runs/${body.id}`).expect(200);
    const run = runRes.body as unknown as {
      status: string;
      action: { type: string };
    };
    expect(run.status).toBe('COMPLETED');
    expect(run.action.type).toBe('REIMBURSEMENT_APPROVED');
  });

  it('rejects a webhook with a bad signature even in DEMO', async () => {
    await request(app.getHttpServer() as App)
      .post('/webhooks/mail')
      .set('content-type', 'application/json')
      .set('svix-id', 'x')
      .set('svix-timestamp', '0')
      .set('svix-signature', 'v1,bad')
      .send('{}')
      .expect(401);
  });
});

describe('DEMO mode off', () => {
  let app: INestApplication;
  beforeAll(async () => {
    delete process.env.DEMO;
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  // The route is always registered (see demo.module.ts comment); DemoController
  // itself returns 404 unless the injected MAIL_PROVIDER is a DemoMailProvider.
  it('returns 404 for /demo/outbox when DEMO is off', async () => {
    await request(app.getHttpServer() as App)
      .get('/demo/outbox')
      .expect(404);
  });
});
