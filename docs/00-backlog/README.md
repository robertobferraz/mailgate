# 00-backlog — ideas and pending items

- 0001 done · F6 demo and publication workstream
- 0002 done · tell the sender when a request was already decided
- 0003 done · GET /runs/:id/timeline HTML page
- 0004 done · triage npm audit high-severity findings
- 0005 done · graceful worker shutdown (await in-flight tick)
- 0006 done · idempotent RESUMED timeline event
- 0007 done · per-row backoff for failing outbox sends
- 0008 done · OpenAI-compatible LLM adapter (Groq/OpenAI direct)
- 0009 done · dead-letter for inbound events that exhaust attempts
- 0010 done · expiry edge hardening (deadline in decide, outbox vs expiry, drain loop, IGNORED_EXPIRED)
- 0011 open · timing-based race tests in the inbound int specs can flake
- 0012 open · shutdown abort reaches only the agent LLM call
- 0013 open · OpenAI-compatible adapter follow-ups (is_error, empty choices, factory boot test, LLM_MODEL check)
- 0014 open · timeline attempts counter disagrees with the attempt shown on the event
