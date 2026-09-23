# 0005 — Claude history is append-only
date: 2026-09-23
rule: append response.content verbatim to runs.messages; never edit or drop earlier messages or thinking blocks.
why:  edited history breaks thinking-block replay and the persist-before-tool crash-recovery guarantee.
example: messages = [...messages, { role: 'assistant', content: response.content }]
