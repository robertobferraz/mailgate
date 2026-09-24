# 0006 — Dead-letter written only in the catch strands rows whose last attempt dies
date:  2026-09-24
what broke: inbound events that died on their last attempt (crash, SIGKILL, shutdown, Prisma disconnect) kept attempts = MAX and outcome NULL — never claimable again and never marked FAILED; the approver's reply was silently dropped.
why:   markFailed ran only from the in-process catch; claimNext filters attempts < MAX, so a pass that never reaches the catch leaves the row in a state no code path visits.
how to avoid: a dead-letter needs a sweep that does not depend on the failing process — an UPDATE on the DB clock for outcome IS NULL AND attempts >= MAX AND lease lapsed (InboundEventRepository.failExhausted). Test it with a row seeded in that state.
cost:  found only by the whole-window final review of f6-hardening w2, after all per-task reviews had passed; one extra fix wave.
