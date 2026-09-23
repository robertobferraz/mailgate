# 0004 — Webhook only stores; a processor decides
date:     2026-09-23
status:   active
context:  the roadmap inserted the event for dedupe and then classified with the LLM in the same request. A crash after the insert would make the provider retry hit the dedupe row and lose the manager's reply.
decision: POST /webhooks/mail verifies the signature, inserts into inbound_events with outcome NULL and returns 200; a worker-side processor claims pending events (SKIP LOCKED + lease), correlates, checks sender, classifies outside any transaction and applies the decision in one locking transaction.
consequences: webhook answers in milliseconds; I3 still holds by primary key; replies are never lost to crashes; decision latency is one worker tick.
source:   workstream mailgate · /sdd start (brainstorm + research) · spec §8
