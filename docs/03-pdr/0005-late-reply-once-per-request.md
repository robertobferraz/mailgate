# 0005 — Tell the approver once when a reply arrives too late
date:     2026-09-23
status:   active
context:  pdr 0003 dropped any email back to a reply on a decided or expired request, so a manager who answers late never learns why nothing happened (backlog 0002). This supersedes 0003; its clarification rule is kept unchanged.
decision: an UNCLEAR reply still triggers at most one clarification per request; a reply from approver_email to a DECIDED or EXPIRED request triggers at most one in-thread reply stating the decision or the expiry, guarded by late_reply_sent.
consequences: one extra email path and one column; at most two automatic emails per request, so no loop with auto-responders; other senders still get nothing (I6).
source:   workstream f6-hardening · /sdd start (brainstorm + research)
