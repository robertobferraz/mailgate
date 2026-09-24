# 0006 — External calls made under a lease are bounded below the lease
date: 2026-09-24
rule: any network call made while holding a lease (run lease, outbox send_lease_until, inbound lease_until) has an explicit timeout and retry budget whose worst case is shorter than the lease; the job's own backoff is the retry.
why:  SDK defaults (e.g. AgentMail/Fern ~60s timeout + 2 retries) outlast a 60s lease; the lease lapses mid-call, expiry or a second worker takes the row, and the in-flight result lands on a row someone else now owns.
example: src/mail/agentmail.provider.ts — send() passes { timeoutInSeconds: 20, maxRetries: 0 } against SEND_LEASE_SECONDS = 60 in outbox.service.ts
