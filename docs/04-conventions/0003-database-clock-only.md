# 0003 — Time logic uses the database clock
date: 2026-09-23
rule: lease, backoff and expiry comparisons use now() in SQL, never new Date() from Node; timestamps are @db.Timestamptz(3).
why:  mixing clocks and timestamp-without-timezone causes early or late lease expiry.
example: lease_until = now() + make_interval(secs => $1)
