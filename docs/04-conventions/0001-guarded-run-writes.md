# 0001 — Worker writes to a run are guarded by lease token
date: 2026-09-23
rule: every UPDATE the worker makes on runs must filter by id, lease_token and expected status, and treat 0 affected rows as LeaseLostError.
why:  without the token a worker whose lease expired keeps writing after another worker reclaimed the run (breaks I4).
example: prisma.run.updateMany({ where: { id, leaseToken, status: 'RUNNING' }, data }) → if (count === 0) throw new LeaseLostError()
