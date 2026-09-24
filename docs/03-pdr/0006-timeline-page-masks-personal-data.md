# 0006 — Public timeline page masks personal data
date:     2026-09-23
status:   active
context:  GET /runs/:id/timeline is public like GET /runs/:id and will be linked from the README demo; events carry the approver address and raw error text.
decision: the HTML page masks the approver email (g***@domain.com) and shows only the error class; the JSON API stays unchanged.
consequences: the demo link can be shared without exposing addresses; the API without auth remains a documented limit.
source:   workstream f6-hardening · /sdd start (brainstorm + research)
