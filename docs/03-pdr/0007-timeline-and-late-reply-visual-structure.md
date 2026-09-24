# 0007 — Timeline page and late reply visual structure
date:     2026-09-23
status:   active
context:  the first w1 mocks of the late reply email (spec 0005) and the timeline page (spec 0006) were flat text; the user asked for a better design before approving. pdr 0004 only covered the approval email.
decision: the late reply opens with a "Situação do pedido" block in the amountBlock style (value in ink, never accent) followed by the date row and the verbatim sentences; the timeline page shows a status dot (accent while running, ink when completed, #b42318 when failed, muted when expired), a "Atualiza sozinha a cada 2 segundos" line only while non-terminal, a label/value grid, a vertical rail with time per event and the date once per day, and a hollow "Aguardando resposta de g***@… até …" next step while waiting for approval.
consequences: the timeline page uses one <style> block, which relies on style-src 'unsafe-inline' in its CSP (spec 0006); #b42318 is the only color outside the pdr 0004 tokens and is local to the timeline; the pulse animation is off under prefers-reduced-motion; the late reply email stays inline-styled and table-based.
source:   workstream f6-hardening w1 · chat ("melhora um pouco esse design", approved "ficou bom")
