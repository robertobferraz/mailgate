# 0003 — Reply handling: one clarification, no auto-reply after decision
date:     2026-09-23
status:   active
context:  managers reply in free text; some replies are ambiguous or arrive after the decision or expiry.
decision: an UNCLEAR reply triggers at most one clarification email per request; replies to already decided or expired requests are recorded as IGNORED_ALREADY_DECIDED with no email back.
consequences: fewer emails and fewer failure paths; the optional "tell the sender it was already decided" from the roadmap is dropped (see backlog 0002).
source:   workstream mailgate · /sdd start (brainstorm + research)
