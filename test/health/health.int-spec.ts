import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createTestApp } from '../helpers/app';

describe('GET /health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns 200 {status: ok} when the database is reachable', async () => {
    await request(app.getHttpServer() as App)
      .get('/health')
      .expect(200, { status: 'ok' });
  });
});
