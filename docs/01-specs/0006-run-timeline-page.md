# 0006 — Run timeline page
date:     2026-09-23
route:    GET /runs/:id/timeline
purpose:  a public, read-only HTML view of one run's progress, used for the README demo GIF
approved: approved

## Behavior
- given a known run id, then 200 text/html; charset=utf-8 with a strict CSP (default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none') and X-Content-Type-Options: nosniff
- given a non-terminal run (PENDING, RUNNING, WAITING_APPROVAL), then the page carries meta refresh every 2s; given COMPLETED, FAILED or EXPIRED, then no refresh
- given any user-controlled string (description, note, event data), then it is HTML-escaped, including '
- given the approver email, then it is masked as g***@domain.com; given an error text, then only its class (transient / permanent) is shown
- given an invalid uuid, then 400; given an unknown id, then 404

## States
loading: n/a (server-rendered) · empty: run with no events shows the header only · error: 400 / 404 as JSON like GET /runs/:id · success: header + approval block + event list

## Data
- from RunsService.getView(): status, amountCents, description, category, attempts, approval { recommendation, expiresAt, decision, note, approverEmail (masked) }, events[] { at, type, data } ordered by (at, id)
- event labels in Portuguese; times in America/Sao_Paulo via formatDeadline; visual tokens of pdr 0004
- mock in docs/mocks/
