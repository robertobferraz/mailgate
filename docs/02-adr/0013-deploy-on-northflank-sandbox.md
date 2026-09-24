# 0013 — Deploy on Northflank Developer Sandbox
date:     2026-09-23
status:   active
context:  the worker loop runs in the API process, so the host must never sleep; the webhook needs a stable HTTPS URL; budget is free or near free. Render and Koyeb free tiers sleep; Neon free suspends and the 1s poll would exhaust its compute hours.
decision: deploy one service from the Dockerfile plus a managed Postgres 16 addon on Northflank's free sandbox, start command runs prisma migrate deploy then node, health GET /health, one instance, DB_POOL_MAX=3; Railway Hobby is plan B.
consequences: $0/month if the sandbox has enough memory (else nf-compute-20, US$5.40); the user owns the account and secrets; steps live in docs/deploy.md.
source:   workstream f6-hardening · /sdd start (brainstorm + research) · RESEARCH.md Q1
