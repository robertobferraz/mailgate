# Deploy guide (Northflank)

This guide deploys mailgate to [Northflank](https://northflank.com) with a managed PostgreSQL 16 addon, a public HTTPS URL for the AgentMail webhook, and no `DEMO` mode.

## 1. Prerequisites

- A Northflank account — **create it yourself**; this guide does not do it for you.
- An AgentMail inbox and its webhook secret (`AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET`).
- An LLM key: an Anthropic API key (`LLM_PROVIDER=anthropic`, the default), or a key for an OpenAI-compatible provider such as Groq (`LLM_PROVIDER=openai-compatible`, `LLM_API_KEY`, `LLM_MODEL`).

## 2. Create the project and a PostgreSQL 16 addon

1. In Northflank, create a new **Project** for mailgate.
2. Inside the project, add an **Addon** → PostgreSQL, version **16**. Wait for it to provision and note its connection string (Northflank exposes it as a secret you can reference from the service).

## 3. Service from the repo `Dockerfile`

Create a **Combined Service** (build from the repo's `Dockerfile`) with:

- **Port**: `3000`, public, protocol HTTP.
- **Start command**: `sh -c "npx prisma migrate deploy && node dist/main.js"` — migrations run before the process starts serving traffic.
- **Health check**: HTTP `GET /health`.
- **Instances**: `1` — the worker uses a Postgres lease, not a distributed lock, so a second instance would contend for the same lease (see [docs/02-adr](02-adr/README.md)).

## 4. Environment via a secret group

Create a secret group and attach it to the service. Set:

- `DATABASE_URL` — the addon's connection string. If Northflank's Postgres refuses a plain connection, append `?sslmode=require`.
- `DB_POOL_MAX=3` — keep the pool small on a shared/sandbox Postgres plan.
- `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, and optionally `LLM_BASE_URL` — per the provider chosen in step 1.
- `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET`.
- **Never set `DEMO`** — this is a real deployment; `DEMO` swaps in a fake LLM and in-memory mail, and the app already refuses to boot with `DEMO=true` when `NODE_ENV=production`.

## 5. Register the AgentMail webhook

Once the service has a public URL, register the webhook in AgentMail:

- URL: `https://<service-url>/webhooks/mail`
- Event: `message.received`

## 6. Smoke test

```bash
curl https://<url>/health
```

Then post a run for R$ 840 (above the R$ 500 auto-approve limit), reply from the approver mailbox with an approve/reject phrase, and watch it resolve at `https://<url>/runs/<id>/timeline`.

```bash
curl -s https://<url>/runs -H 'content-type: application/json' -d '{
  "description": "Hotel em SP para visita a cliente",
  "amountCents": 84000,
  "category": "TRAVEL",
  "requesterEmail": "ana@acme.test",
  "approverEmail": "<approver mailbox>"
}'
```

## 7. If the sandbox runs out of memory

Move the service to the `nf-compute-20` plan.

**Plan B:** deploy to Railway Hobby instead, with the same environment variables and the same start command (`sh -c "npx prisma migrate deploy && node dist/main.js"`).
