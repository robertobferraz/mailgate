# 0013 — OpenAI-compatible adapter follow-ups
date:    2026-09-24
state:   open
context: f6-hardening w4 final review, parked items — a tool_result's is_error flag is lost in the role:tool message (only the text reaches the model); a 200 with empty choices throws a TypeError retried until MAX_ATTEMPTS; no test boots the module factories with LLM_PROVIDER=openai-compatible; LLM_MODEL is only documented, not validated, as required for that provider
value:   weaker models can read an error result as success, a broken gateway burns retries, and a misconfigured deploy fails every run with a 404 instead of failing at boot
