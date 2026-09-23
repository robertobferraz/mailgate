import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createTestApp } from '../helpers/app';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

describe('runs API', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = newPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(() => truncateAll(prisma));

  it('POST /runs creates a PENDING run with a CREATED event', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/runs')
      .send({ ...validInput(), approverEmail: 'GESTOR@ACME.TEST' })
      .expect(201);
    const created = res.body as unknown as { id: string; status: string };
    expect(typeof created.id).toBe('string');
    expect(created.status).toBe('PENDING');
    const run = await prisma.run.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(run.status).toBe('PENDING');
    expect((run.input as { approverEmail: string }).approverEmail).toBe(
      'gestor@acme.test',
    );
    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'CREATED' },
      }),
    ).toBe(1);
  });

  it.each([
    ['float amount', { amountCents: 840.5 }],
    ['numeric string amount', { amountCents: '84000' }],
    ['missing approver', { approverEmail: undefined }],
    ['bad category', { category: 'FUN' }],
    ['extra field', { hack: true }],
  ])('POST /runs rejects %s with 400 and stores nothing', async (_l, patch) => {
    const res = await request(app.getHttpServer() as App)
      .post('/runs')
      .send({ ...validInput(), ...patch })
      .expect(400);
    expect((res.body as { errors: unknown[] }).errors.length).toBeGreaterThan(
      0,
    );
    expect(await prisma.run.count()).toBe(0);
  });

  it('GET /runs/:id returns the view with an ordered timeline', async () => {
    const createRes = await request(app.getHttpServer() as App)
      .post('/runs')
      .send(validInput())
      .expect(201);
    const created = createRes.body as { id: string };
    const res = await request(app.getHttpServer() as App)
      .get(`/runs/${created.id}`)
      .expect(200);
    expect(res.body).toMatchObject({
      id: created.id,
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      approval: null,
      action: null,
      input: validInput(),
    });
    expect(
      (res.body as { timeline: { type: string }[] }).timeline.map(
        (e) => e.type,
      ),
    ).toEqual(['CREATED']);
  });

  it('GET /runs/:id returns 404 for an unknown id and 400 for a non-uuid', async () => {
    await request(app.getHttpServer() as App)
      .get('/runs/7a0c7c9e-3f6f-4a8e-9a55-0b8a7b3f3c11')
      .expect(404);
    await request(app.getHttpServer() as App)
      .get('/runs/not-a-uuid')
      .expect(400);
  });
});
