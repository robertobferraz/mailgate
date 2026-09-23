# 0001 — Auto-approve limit and agent autonomy
date:     2026-09-23
status:   active
context:  demo scenario: the agent decides alone up to R$ 500 and asks the manager above that.
decision: amounts up to 50000 cents (AUTO_APPROVE_LIMIT_CENTS) may be approved by the agent alone; above it approval requires a human DECIDED request; the agent may reject alone at any amount below the limit; after a human decision the recorded action must match it.
consequences: the rule lives in the system prompt and is enforced in record_decision code, which returns an is_error tool_result when violated.
source:   workstream mailgate · /sdd start (brainstorm + research)
