# 0005 — Late reply email
date:     2026-09-23
route:    email reply in the approval thread → approver_email
purpose:  tell the approver, once, that their reply had no effect because the request was already decided or expired
approved: approved

## Behavior
- given a reply from approver_email to a DECIDED request and late_reply_sent=false, then one in-thread reply states the decision (approved/rejected) and when it was taken (Idempotency-Key late-<approvalId>), and the flag becomes true; outcome IGNORED_ALREADY_DECIDED
- given a reply from approver_email to an EXPIRED request (or SENT past expires_at) and late_reply_sent=false, then one in-thread reply states the request expired and its deadline; outcome IGNORED_EXPIRED
- given late_reply_sent=true, when another late reply arrives, then nothing is sent
- given a reply from any other sender, then nothing is sent (IGNORED_SENDER, I6)
- given the late state is discovered inside the decision transaction (race), then the reply is sent only after the commit, never inside it

## States
loading: n/a · empty: n/a · error: send failure leaves the inbound event pending for retry (dead-letter after MAX_ATTEMPTS) · success: late_reply_sent=true

## Data
- decision: APPROVED | REJECTED | EXPIRED
- decidedAt (DECIDED) or expiresAt (EXPIRED), formatted in America/Sao_Paulo
- decisionNote when present
- text/html + text/plain, visual direction of pdr 0004; renderer renderLateReplyEmail in src/mail/templates.ts; mock in docs/mocks/
