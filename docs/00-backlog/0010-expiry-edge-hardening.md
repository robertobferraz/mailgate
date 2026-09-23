# 0010 — expiry edge hardening
date:    2026-09-23
state:   open
context: w7 T19 review minors. The decision path checks only `status = 'SENT'`, not `expires_at`, so a reply up to EXPIRY_INTERVAL_MS after the deadline is still accepted. The outbox reads CREATED rows without a lock and may send an approval that expiry just flipped to EXPIRED. Each pass expires at most 50 rows once per interval (backlog drains at 50/min). A reply after expiry is labeled IGNORED_ALREADY_DECIDED because the outcome CHECK has no IGNORED_EXPIRED.
value:   the 48h deadline becomes exact (decide also requires `expires_at > now()`), no approval e-mail leaves after expiry, large backlogs drain in one tick (loop while a pass returns BATCH), and the audit label tells expired from decided (one migration adding IGNORED_EXPIRED).
