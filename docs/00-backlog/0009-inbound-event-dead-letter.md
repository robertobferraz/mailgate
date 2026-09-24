# 0009 — dead-letter for inbound events that exhaust attempts
date:    2026-09-23
state:   done
context: InboundEventRepository.claimNext skips events with attempts >= MAX_ATTEMPTS, but they keep outcome NULL forever (w6 T17 review). Related: setOutcome is not guarded by `outcome IS NULL`, so a lease-outliving classifier can let a re-claim overwrite PROCESSED with IGNORED_ALREADY_DECIDED (audit only; I2 holds).
value:   a failed reply becomes visible (terminal outcome such as FAILED, plus a log/metric) instead of silently pending, and the audit trail of an event can no longer be overwritten.
