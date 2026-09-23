import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export default async function globalTeardown(): Promise<void> {
  await (globalThis as { __PG__?: StartedPostgreSqlContainer }).__PG__?.stop();
}
