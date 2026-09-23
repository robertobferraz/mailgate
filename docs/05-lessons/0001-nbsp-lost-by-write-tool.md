# 0001 — Non-breaking space silently lost when writing source files
date:  2026-09-23
what broke: src/mail/format.ts needs a literal U+00A0 in its regex (Intl pt-BR output uses NBSP); the agent's file Write tool normalized it to a plain space, so the replace became a no-op without any error.
why:   editor/tool text pipelines normalize invisible whitespace; the character cannot be seen in a diff or review of file contents.
how to avoid: write invisible characters as escapes (` `) instead of literals; keep a test that asserts the exact formatted string (format.spec.ts does); check bytes with `grep -c $'\xc2\xa0' <file>` when a literal is unavoidable.
cost:  an extra implementer round and a hex-dump check in w1 T2.
