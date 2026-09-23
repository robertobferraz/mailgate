# 0006 — idempotent RESUMED timeline event
date:    2026-09-23
state:   open
context: w4 T12 review — AgentRunner appends the RESUMED run event outside the lease fence and before the tool_result is saved; a lease loss or crash between the two makes the next claim append RESUMED again.
value:   keeps the D009 timeline honest (one resume per decision). Fix: write RESUMED in the same transaction as the fenced save, or skip it when a RESUMED event for the same approvalId already exists.
