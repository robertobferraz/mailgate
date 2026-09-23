# End-to-end

## Spike

The AgentMail send-idempotency spike (`scripts/agentmail-spike.ts`, run with
`npx ts-node scripts/agentmail-spike.ts`) needs `AGENTMAIL_API_KEY`,
`AGENTMAIL_INBOX_ID`, and `AGENTMAIL_SPIKE_TO` in `.env`.

Result (2026-09-23, run by the user against the real AgentMail API, agentmail 0.5.27):

- Two `send` calls with the same `Idempotency-Key` returned the same `messageId`
  (an Amazon SES message id) and the same `threadId` (a UUID).
- `idempotent: true`. D005 and D016 hold: send-then-mark is safe to retry.
- Real thread ids are UUIDs, not the `thr_` prefix the test fake uses. Nothing
  depends on the prefix outside the fake.

## F3 acceptance

Run 2026-09-23 by the controller with the user's authorization: local API on port 3001,
`LLM_PROVIDER=anthropic-compatible` with Ollama 0.34.0 and `qwen3:8b`, real AgentMail.

- `POST /runs` with 84000 cents and `approverEmail` set to the user's inbox.
- After about 45 s (local model), `GET /runs/:id` returned `WAITING_APPROVAL` with the
  approval `SENT` and `attempts` 0.
- Events in order: `CREATED`, `CLAIMED`, `APPROVAL_REQUESTED`, `APPROVAL_SENT`.
- The approval row has recommendation `APPROVE`, a pt-BR summary, a provider thread id,
  and no `last_error`.
- Delivery and rendering: the user confirmed a single spike e-mail and the approval e-mail arrived, matching `docs/mocks/approval.html`.

## Setup

1. `.env` (D022, ADR 0007 — never `ANTHROPIC_API_KEY`):
   - `LLM_PROVIDER` (`anthropic` or `anthropic-compatible`), `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`.
   - `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET` (from the webhook created in AgentMail).
2. `docker compose up -d postgres && npx prisma migrate deploy && npm run start:dev`
3. The API listens on `PORT` (default 3000; locally 3001 may be used when 3000 is taken by another project — use `localhost:$PORT` in the commands below).
4. Expose the API: `cloudflared tunnel --url http://localhost:$PORT` (or `ngrok http $PORT`).
5. In AgentMail, point a webhook for `message.received` at `<tunnel-url>/webhooks/mail`.

## Flow

1. `curl -s localhost:$PORT/runs -H 'content-type: application/json' -d '{"description":"Hotel SP","amountCents":84000,"category":"TRAVEL","requesterEmail":"ana@acme.test","approverEmail":"<your inbox>"}'`
2. `GET /runs/<id>` → `WAITING_APPROVAL`, approval `SENT`.
3. Reply to the e-mail from `<your inbox>` with an unclear message first (e.g. "hmm?") — expect exactly one clarification e-mail in the same thread, approval still `SENT`.
4. Reply again with "pode aprovar".
5. `GET /runs/<id>` → `COMPLETED`, `action.type = REIMBURSEMENT_APPROVED`, timeline contains APPROVAL_SENT → CLARIFICATION_SENT → DECISION_RECEIVED → RESUMED → ACTION_RECORDED → COMPLETED.

## F4 acceptance

Run 2026-09-23 by the controller with the user's authorization: local API on port 3001 behind an
ngrok tunnel, `LLM_PROVIDER=anthropic-compatible` with Ollama 0.34.0 and `qwen3:8b`, real AgentMail
with a `message.received` webhook pointing at `<tunnel>/webhooks/mail`.

- `POST /runs` with 84000 cents and `approverEmail` set to the user's inbox. The run reached
  `WAITING_APPROVAL` with the approval `SENT`.
- The user replied "pode aprovar" from their mail client (subject `RE: [mailgate #<token>] ...`).
- First attempt found a bug: the webhook answered 200 with `stored: false`. In svix 2.5.0,
  `Webhook.verify` only verifies and returns `undefined`, and `parseInbound` used that return value
  as the body. Fixed by parsing the raw body after verification; a regression test signs a
  real-shaped AgentMail payload. The first reply was lost (AgentMail got a 200, and replaying it
  failed the 5-minute signature tolerance), so the user replied again.
- Second reply: stored, correlated by thread id, sender matched, classified `APPROVED`, approval
  `DECIDED`, run resumed and finished `COMPLETED` with one action `REIMBURSEMENT_APPROVED`.
- Timeline: CREATED → CLAIMED → APPROVAL_REQUESTED → APPROVAL_SENT → DECISION_RECEIVED → CLAIMED →
  RESUMED → ACTION_RECORDED → COMPLETED.
- Not exercised with real providers: the UNCLEAR clarification e-mail. It is covered by
  `test/inbound/unclear.int-spec.ts` against the fake provider.
