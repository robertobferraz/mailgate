# 0003 — Postgres queue with lease and fencing token
date:     2026-09-23
status:   active
context:  runs must survive restarts and never be processed by two workers (I4). A lease alone lets a stalled worker keep writing after another worker reclaims the run.
decision: claim runs with one UPDATE ... (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING that sets a fresh lease_token; every worker write to the run is guarded by id + lease_token + status, and 0 affected rows means the lease was lost.
consequences: no Redis or external queue; worker runs in the API process. The lease is renewed on every persisted step (no heartbeat). lease_until doubles as "not eligible before" for PENDING backoff. attempts counts claims since the last human checkpoint and resets on decision.
source:   workstream mailgate · /sdd start (brainstorm + research) · spec §6
