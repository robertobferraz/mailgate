# 0001 — Approval request email
date:     2026-09-23
route:    email → approver_email · subject "[mailgate #<subject_token>] Reembolso de R$ <amount> — aprovação necessária"
purpose:  ask the manager to approve or reject a reimbursement above the auto-approve limit, replying in natural language
approved: approved

## Behavior
- given an approval request in CREATED, when the worker outbox runs, then one email is sent with Idempotency-Key approval-<id> and the request becomes SENT
- given the manager replies in the same thread, when the reply is classified APPROVED or REJECTED, then the run resumes with that decision
- given the manager's mail client breaks threading, when the subject still carries [mailgate #<token>], then the reply is correlated by token
- given expires_at passes with no valid reply, then request and run become EXPIRED

## States
loading: n/a (email) · empty: n/a · error: send failure keeps CREATED and retries next tick · success: SENT with provider_thread_id

## Data
- subject_token (8 chars base32)
- input.description, input.category, input.amountCents (rendered as BRL, pt-BR), input.requesterEmail
- summary (agent), recommendation APPROVE|REJECT + rationale (agent)
- instruction: "Responda este e-mail com APROVO ou RECUSO (pode incluir um comentário)."
- expires_at rendered pt-BR, America/Sao_Paulo
- formats: text + simple HTML; mocks in docs/mocks/approval.{html,txt}
