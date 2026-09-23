# 0006 — Jest with Testcontainers against real Postgres
date:     2026-09-23
status:   active
context:  concurrency guarantees (I1–I6) cannot be proven with mocks. Prisma 7's new generator has known friction with Jest; current NestJS docs lean to Vitest.
decision: keep Jest + ts-jest with @testcontainers/postgresql in globalSetup running prisma migrate deploy, TRUNCATE per test, --runInBand, one PrismaClient per simulated worker; apply moduleNameMapper '^(\\.{1,2}/.*)\\.js$' → '$1'.
consequences: tests need Docker locally and in CI. Vitest stays an option if the workaround stops working. External APIs are always faked in CI.
source:   workstream mailgate · /sdd start (brainstorm + research) · RESEARCH.md Q3
