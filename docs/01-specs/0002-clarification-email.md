# 0002 — Clarification email
date:     2026-09-23
route:    email reply in the approval thread → approver_email
purpose:  ask once for an unambiguous answer when the manager's reply is classified UNCLEAR
approved: approved

## Behavior
- given a valid-sender reply classified UNCLEAR and clarification_sent=false, then one reply is sent in-thread (Idempotency-Key clarify-<approvalId>) and the flag becomes true
- given clarification_sent=true, when another UNCLEAR reply arrives, then nothing is sent (outcome IGNORED_UNCLEAR)
- given the request is no longer SENT, then no clarification is sent

## States
loading: n/a · empty: n/a · error: send failure leaves the inbound event pending for retry · success: outcome CLARIFICATION_SENT

## Data
- text: "Não consegui entender sua resposta. Responda apenas APROVO ou RECUSO."
- threading: reply to the inbound message id
- mock in docs/mocks/clarification.txt
