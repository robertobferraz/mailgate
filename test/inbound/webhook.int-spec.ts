import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient } from '../../src/generated/prisma/client';
import { MAIL_PROVIDER } from '../../src/mail/mail-provider';
import { FakeMailProvider, replyPayload } from '../fakes/fake-mail';
import { createTestApp } from '../helpers/app';
import { newPrisma, truncateAll } from '../helpers/db';

describe('POST /webhooks/mail', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(MAIL_PROVIDER).useValue(new FakeMailProvider()),
    );
    prisma = newPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(() => truncateAll(prisma));

  const post = (eventId: string, body: unknown, signed = true) => {
    const r = FakeMailProvider.signedRequest(eventId, body);
    const headers = signed
      ? r.headers
      : { ...r.headers, 'x-fake-signature': 'bad' };
    return request(app.getHttpServer() as App)
      .post('/webhooks/mail')
      .set(headers)
      .send(JSON.stringify(body));
  };

  it('401 on an invalid signature and stores nothing', async () => {
    await post(
      'evt_1',
      replyPayload({ threadId: 't', from: 'g@x.t', text: 'aprovo' }),
      false,
    ).expect(401);
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it('200 and not stored for other event types', async () => {
    await post('evt_2', { event_type: 'message.sent', message: {} }).expect(
      200,
      { received: true, stored: false },
    );
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it('stores message.received with outcome NULL', async () => {
    await post(
      'evt_3',
      replyPayload({
        threadId: 'thr_1',
        from: 'Gestor <GESTOR@ACME.TEST>',
        text: 'pode aprovar',
      }),
    ).expect(200, { received: true, stored: true });
    const row = await prisma.inboundEvent.findUniqueOrThrow({
      where: { providerEventId: 'evt_3' },
    });
    expect(row.outcome).toBeNull();
    expect(row.payload).toMatchObject({
      threadId: 'thr_1',
      from: 'gestor@acme.test',
      text: 'pode aprovar',
    });
  });

  it('I3 — the same svix-id twice yields one row and 200 both times', async () => {
    const body = replyPayload({
      threadId: 'thr_1',
      from: 'g@x.t',
      text: 'aprovo',
    });
    await post('evt_dup', body).expect(200, { received: true, stored: true });
    await post('evt_dup', body).expect(200, { received: true, stored: false });
    expect(await prisma.inboundEvent.count()).toBe(1);
  });

  it('stores a signed event without thread id (correlated later by subject token)', async () => {
    await post(
      'evt_4',
      replyPayload({
        threadId: null,
        from: 'g@x.t',
        text: 'aprovo',
        subject: 'RES: [mailgate #abcd2345] x',
      }),
    ).expect(200);
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'evt_4' },
        })
      ).payload,
    ).toMatchObject({ threadId: null, subject: 'RES: [mailgate #abcd2345] x' });
  });
});
