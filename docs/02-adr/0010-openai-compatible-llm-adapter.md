# 0010 — OpenAI-compatible LLM adapter over chat.completions
date:     2026-09-23
status:   active
context:  adr 0007 covers Anthropic-compatible endpoints only; Groq and OpenAI need a separate adapter (backlog 0008). Groq's Responses API is beta and stateless; chat.completions is the portable surface.
decision: add LLM_PROVIDER=openai-compatible, implemented with the openai SDK (exact version) on chat.completions and hand-written pure translation to and from Anthropic.Message; parallel_tool_calls false and only the first tool_use kept; invalid arguments JSON becomes input {}; the classifier uses response_format json_schema with strict behind LLM_STRICT_OUTPUT and keeps Zod safeParse → UNCLEAR.
consequences: the LlmClient port, append-only history (convention 0005) and runner are unchanged; one more SDK dependency; non-strict Groq models may yield UNCLEAR more often. Complements 0007, does not supersede it.
source:   workstream f6-hardening · /sdd start (brainstorm + research) · RESEARCH.md Q3
