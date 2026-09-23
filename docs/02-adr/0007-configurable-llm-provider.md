# 0007 — Configurable LLM provider via Anthropic-compatible base URL
date:     2026-09-23
status:   active
context:  0005 fixed the model to Anthropic (claude-opus-5, server-side fallback) and the classifier to messages.parse. Running locally or on another AI API needs no Anthropic credits. Ollama (≥0.14), LM Studio (≥0.4.1), OpenRouter and LiteLLM expose Anthropic Messages-compatible endpoints; Groq and OpenAI do not.
decision: select the provider by env — LLM_PROVIDER=anthropic|anthropic-compatible with LLM_BASE_URL, LLM_MODEL, LLM_API_KEY — on the same @anthropic-ai/sdk client; off Anthropic, omit thinking, fallbacks and the server-side-fallback beta header, and classify with messages.create + JSON validated by Zod instead of messages.parse.
consequences: the manual loop, append-only history (convention 0005) and test fakes are unchanged. Local models may emit tool calls as text (ollama#18346); the run then ends without an action and FAILS (D012) — never a wrong approval, since the R$ 500 rule stays in code. Invalid classifier JSON becomes UNCLEAR. Calling Groq/OpenAI directly needs a separate OpenAI-compatible adapter (backlog). Supersedes the model/classifier part of 0005; its loop decision stays active.
source:   workstream mailgate w5 · chat · RESEARCH.md Q5
