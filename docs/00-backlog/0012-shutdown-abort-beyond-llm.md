# 0012 — Shutdown abort reaches only the agent LLM call
date:    2026-09-24
state:   open
context: f6-hardening w2 — after the grace period only the run's LLM call is aborted; a tool step, the inbound classifier call or an outbox send already in flight keeps running while Prisma disconnects (the side loop now stops taking new work)
value:   interrupted work is recovered only by lease expiry, and an inbound event loses an attempt; passing the AbortSignal to the classifier and mail provider would release it cleanly
