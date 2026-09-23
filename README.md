# mailgate

Durable human-in-the-loop for AI agents via e-mail: the agent pauses at a decision point, e-mails an approver, and resumes only when the reply arrives — even hours later, even after a restart.

## Quickstart

```bash
cp .env.example .env        # fill LLM_* and AGENTMAIL_* for the real flow
docker compose up --build
curl localhost:3000/health  # {"status":"ok"}
```

If port 3000 is already in use on the host, set `API_PORT` instead: `API_PORT=3001 docker compose up --build`.

## Development

```bash
npm ci && npx prisma generate
npm test            # unit
npm run test:int    # integration (needs Docker)
npm run test:stress # concurrency suite 20x
```

Design: `docs/superpowers/specs/mailgate/design.md` · API: `docs/api/openapi.yaml`
