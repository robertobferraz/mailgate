# 0007 — Reasoning models spend the classifier's token budget before the JSON
date:  2026-09-24
what broke: the OpenAI-compatible reply classifier capped max_completion_tokens at 512; with openai/gpt-oss-120b (the documented Groq model) hidden reasoning tokens count against that cap, so a clear "aprovo" could come back cut off (finish_reason length) with empty or partial JSON, parse as UNCLEAR and send the run's one-and-only clarification e-mail.
why:   on reasoning models max_completion_tokens covers reasoning plus visible output, and a truncated answer looked exactly like bad output, so the UNCLEAR fallback hid it.
how to avoid: size completion budgets for reasoning (2000, same as the Claude native branch) and treat finish_reason 'length' as an error to retry, never as the model's answer. Fallbacks like UNCLEAR are only for output the model finished.
cost:  passed both per-task reviews; caught by the whole-window final review of f6-hardening w4, one extra fix wave.
