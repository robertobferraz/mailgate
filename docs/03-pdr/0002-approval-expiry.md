# 0002 — Approval requests expire after 48h, sent or not
date:     2026-09-23
status:   active
context:  the roadmap expired only SENT requests; a request whose send keeps failing would hold its run in WAITING_APPROVAL forever.
decision: expires_at = creation + APPROVAL_TTL_HOURS (48); expiry covers CREATED and SENT and moves the run to EXPIRED.
consequences: a run never waits forever; an expired run never records an action.
source:   workstream mailgate · /sdd start (brainstorm + research)
