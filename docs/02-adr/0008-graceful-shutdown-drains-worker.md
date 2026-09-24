# 0008 — Graceful shutdown drains the worker before Prisma disconnects
date:     2026-09-23
status:   active
context:  Nest 11 runs onModuleDestroy for every module before beforeApplicationShutdown, so PrismaService disconnected before the worker could finish; the fix proposed in backlog 0005 would not work. An in-flight LLM call (up to LLM_TIMEOUT_MS) outlives Docker's default 10s stop.
decision: PrismaService disconnects in onApplicationShutdown; WorkerLoop stops its timers and awaits the in-flight tickRuns/tickSide in beforeApplicationShutdown up to SHUTDOWN_GRACE_MS, then aborts the LLM call via AbortSignal and releases the lease (fenced) back to PENDING without consuming an attempt; compose sets stop_grace_period 15s.
consequences: deploys no longer leave runs RUNNING until lease expiry nor burn attempts; the outbox send→mark window is drained too. Abort becomes a third error class next to transient and permanent.
source:   workstream f6-hardening · /sdd start (brainstorm + research) · RESEARCH.md Q5
