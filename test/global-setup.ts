import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  execSync('npx prisma migrate deploy', { env: process.env, stdio: 'inherit' });
  (globalThis as { __PG__?: StartedPostgreSqlContainer }).__PG__ = container;
}
