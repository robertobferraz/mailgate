# 0004 — No network calls inside database transactions
date: 2026-09-23
rule: LLM calls and email sends happen outside $transaction; transactions only read, lock and write rows.
why:  long transactions hold locks and connections, and a rollback cannot undo an email already sent.
example: classify() → then $transaction(lock approval, decide); send(idempotencyKey) → then updateMany CREATED→SENT
