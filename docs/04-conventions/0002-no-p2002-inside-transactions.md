# 0002 — Never create-and-catch P2002 inside a transaction
date: 2026-09-23
rule: inside $transaction use createMany({ skipDuplicates: true }) or INSERT ... ON CONFLICT DO NOTHING RETURNING to detect "already done".
why:  a unique violation aborts the whole Postgres transaction; every later query fails with "current transaction is aborted".
example: const { count } = await tx.action.createMany({ data: [row], skipDuplicates: true }) // 0 = already executed
