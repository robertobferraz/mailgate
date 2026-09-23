# 0004 — Email visual direction: restrained, neutral, amount first
date:     2026-09-23
status:   active
context:  the emails are the only user-facing surface; at the w1 visual gate the user asked for the amount to stand out, AA contrast, and a better overall design, while keeping the agent's recommendation neutral.
decision: approval and clarification emails share one restrained layout (table-based, inline styles, ~560px, no external assets) where only the amount and the reply instruction get the accent; all text meets WCAG AA 4.5:1; the agent's APROVAR/RECUSAR recommendation carries no color.
consequences: the approver sees the amount and the action first without being nudged toward the agent's suggestion; no logo, hero or CTA button chrome; PRODUCT.md at the repo root holds this direction as context for the impeccable skill; copy stays fixed by tests.
source:   workstream mailgate w1 · chat (visual approval)
