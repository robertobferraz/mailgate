# 0001 — Prisma 7 with raw-SQL repositories for locking
date:     2026-09-23
status:   active
context:  roadmap left ORM open between Prisma and the one used at work; the user uses Prisma. Claim and locks need SKIP LOCKED / FOR UPDATE / ON CONFLICT, which Prisma does not model.
decision: use Prisma 7.x pinned (prisma-client generator, moduleFormat cjs, @prisma/adapter-pg, prisma.config.ts) and keep claim/lock queries as $queryRaw inside repositories with explicit row interfaces and mappers.
consequences: typed CRUD for simple paths; ~30–50% of critical queries hand-typed and covered by Testcontainers tests. Prisma 8 (RC) drops $transaction timeout/isolationLevel, so upgrade is deferred. Kysely/Drizzle would type raw SQL better but are not the team stack.
source:   workstream mailgate · /sdd start (brainstorm + research) · RESEARCH.md Q3
