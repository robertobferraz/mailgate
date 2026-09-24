# 0008 — OpenAI-compatible LLM adapter
date:    2026-09-23
state:   done
context: D022 / ADR 0007 (w5) made the provider configurable through Anthropic Messages-compatible endpoints (Ollama, LM Studio, OpenRouter, LiteLLM). Groq and OpenAI do not expose /v1/messages (RESEARCH.md Q5).
value:   a second LlmClient using the `openai` SDK with baseURL, translating to and from Anthropic.Message, would call Groq/OpenAI directly without an OpenRouter or LiteLLM hop. The port must keep returning Anthropic.Message so the append-only history (convention 0005) holds.
