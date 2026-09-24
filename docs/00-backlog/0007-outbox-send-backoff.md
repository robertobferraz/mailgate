# 0007 — Per-row backoff for failing outbox sends
date:    2026-09-23
state:   done
context: T14 review (w5). A CREATED approval whose send fails permanently (e.g. rejected recipient) is retried on every worker tick until F5 expiry (48h). The ordering fix (lastError nulls first, updatedAt asc) stops it from starving new approvals, but not from hammering the provider.
value:   an attempts column with exponential backoff (DB clock, convention 0003) cuts provider load and makes a stuck row visible instead of silently retried.
