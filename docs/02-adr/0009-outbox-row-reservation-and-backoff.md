# 0009 — Outbox reserves the row and backs off failing sends
date:     2026-09-23
status:   active
context:  the outbox read CREATED rows without a lock, so it could send an approval that expiry had just flipped (backlog 0010), and retried a permanently failing send every tick for 48h (backlog 0007).
decision: in a short transaction the outbox locks a CREATED row with FOR UPDATE SKIP LOCKED, requires expires_at > now() and next_send_at due, and sets send_lease_until; the send happens outside the transaction (convention 0004) and send-then-mark (D016) stays; a failure increments send_attempts and sets next_send_at = now() + least(30s·2^(n-1), 1h) on the database clock (convention 0003).
consequences: no approval email leaves after expiry; provider load from a stuck row drops to one try per hour; expiry remains the only terminal state for sending. Three new columns on approval_requests.
source:   workstream f6-hardening · /sdd start (brainstorm + research)
