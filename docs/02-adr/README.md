# 02-adr — technical decisions

- 0001 active · Prisma 7 with raw-SQL repositories for locking
- 0002 active · AgentMail as the mail provider
- 0003 active · Postgres queue with lease and fencing token
- 0004 active · webhook only stores; a processor decides
- 0005 active · manual Claude tool-use loop with append-only history (model/classifier part superseded by 0007)
- 0006 active · Jest with Testcontainers against real Postgres
- 0007 active · configurable LLM provider via Anthropic-compatible base URL
- 0008 active · graceful shutdown drains the worker before Prisma disconnects
- 0009 active · outbox reserves the row and backs off failing sends
- 0010 active · OpenAI-compatible LLM adapter over chat.completions
- 0011 active · Prisma CLI audit findings: override mysql2, accept deepmerge-ts
- 0012 superseded by 0014 · DEMO mode with fake LLM/mail and real webhook signature
- 0013 active · deploy on Northflank Developer Sandbox
- 0014 active · DEMO mode, with both GIFs recorded by Playwright + gifski
