# mailgate — design (F0–F5)

- **Data:** 2026-09-23
- **Status:** em revisão
- **Fontes:**
  - Roadmap: `docs/roadmap.md`, que é a fonte dos requisitos e é citado aqui por seção.
  - Pesquisa: `.claude/sdd/mailgate/RESEARCH.md`.
- **Escopo:** fases F0 a F5 do roadmap. A F6 (deploy, README final, posts) fica para outro workstream.

## 1. Objetivo

Projeto de portfólio que prova human-in-the-loop durável por e-mail. Um agente analisa um pedido de reembolso e decide sozinho quando o valor é até R$ 500. Acima disso, pausa, envia um e-mail ao gestor e só retoma quando a resposta chega, mesmo horas depois e mesmo que o processo tenha reiniciado nesse meio-tempo.

O sucesso tem três partes:
- as invariantes I1 a I6 (roadmap §3), cada uma com pelo menos um teste contra Postgres real que a comprova;
- os testes de concorrência estáveis em 20 execuções seguidas;
- o fluxo ponta a ponta funcionando com o provider real.

Fora de escopo: o que o roadmap §1 lista, mais a F6 inteira.

## 2. Stack

| Camada | Decisão |
|---|---|
| Backend | NestJS (TypeScript), um processo só: API e loop do worker |
| Banco | PostgreSQL 16 |
| Acesso a dados | Prisma **7.x** fixado: generator `prisma-client` com `moduleFormat = "cjs"`, `@prisma/adapter-pg` e `prisma.config.ts`. Claim e locks em SQL cru, dentro de repositórios |
| LLM | `@anthropic-ai/sdk`, com loop manual de tool use. Provedor por env (D022, ADR 0007): `LLM_PROVIDER=anthropic` (padrão, `LLM_MODEL` `claude-opus-5`, fallback server-side ligado) ou `anthropic-compatible` com `LLM_BASE_URL` (Ollama, LM Studio, OpenRouter, LiteLLM), sem thinking nem fallback |
| E-mail | AgentMail (SDK `agentmail` na versão exata) com webhook Svix. O Resend fica como plano B |
| Testes | Jest + ts-jest + `@testcontainers/postgresql`, com o contorno `moduleNameMapper` para o Prisma 7 |
| Infra | Docker Compose (`postgres`, `migrate`, `api`) e GitHub Actions |

As ADRs seguem o layout da skill `kb` (`docs/02-adr/`), e não o caminho `docs/adr/` citado no roadmap.

## 3. Módulos

| Módulo | Responsabilidade | Porta com fake |
|---|---|---|
| `runs` | `POST /runs`, `GET /runs/:id`, `RunRepository` (claim, transições guardadas por token) e `run_events` | — |
| `worker` | `tick()` agendado por `WORKER_POLL_MS`. Cada tick claima e processa uma run, depois despacha o outbox de e-mail, os eventos inbound e a expiração | — |
| `agent` | Loop de tool use, as ferramentas `request_approval` e `record_decision`, e o system prompt | `LlmClient` |
| `mail` | Templates de e-mail, envio do outbox (`CREATED` → `SENT`), `MailProvider` | `MailProvider` |
| `inbound` | `POST /webhooks/mail`, `InboundProcessor` (correlação, remetente, classificação, decisão) e `ReplyClassifier` | `ReplyClassifier` (e `MailProvider.parseInbound`) |
| `expiry` | Expiração de approval requests e runs | — |
| `health` | `GET /health` | — |

Só há porta onde existe fake nos testes. O `PrismaService` estende o `PrismaClient` com o adapter pg e define `max` e `connectionTimeoutMillis` explícitos. Uma transação que atravessa repositórios recebe o `tx` como parâmetro.

`WORKER_ENABLED=false` desliga o loop, o que serve a testes e a múltiplas réplicas de API. Os testes chamam `tick()` e os passos individuais diretamente.

## 4. Modelo de dados

A convenção é `@@map` e `@map` para snake_case. Todo `timestamptz` usa `@db.Timestamptz(3)`. Status são `text` com CHECK, sem enum Prisma, para não precisar de cast no SQL cru.

```sql
runs (
  id            uuid pk default gen_random_uuid(),
  status        text not null check (status in ('PENDING','RUNNING','WAITING_APPROVAL','COMPLETED','FAILED','EXPIRED')),
  input         jsonb not null,           -- ReimbursementInput (§5.1)
  messages      jsonb not null default '[]',  -- histórico append-only do Claude
  attempts      int not null default 0,   -- claims desde o último checkpoint humano
  lease_token   uuid,                     -- fencing: gerado a cada claim
  lease_until   timestamptz,              -- RUNNING: fim do lease | PENDING: não elegível antes de (backoff)
  last_error    text,
  created_at, updated_at timestamptz not null default now()
)
index parcial: runs (created_at) where status in ('PENDING','RUNNING')

approval_requests (
  id                 uuid pk,
  run_id             uuid not null fk runs,
  tool_use_id        text not null,
  approver_email     text not null,       -- normalizado (lowercase)
  subject_token      text not null unique,-- 8 chars base32, fallback de correlação
  summary            text not null,
  recommendation     text not null,
  status             text not null check (status in ('CREATED','SENT','DECIDED','EXPIRED')),
  decision           text check (decision in ('APPROVED','REJECTED')),
  decision_note      text,
  decision_raw_text  text,                -- texto original da resposta que decidiu
  provider_message_id text,
  provider_thread_id  text,               -- index
  clarification_sent boolean not null default false,
  last_error         text,
  expires_at         timestamptz not null,-- definido na criação: now() + APPROVAL_TTL_HOURS
  created_at, updated_at,
  unique (run_id, tool_use_id)
)

inbound_events (
  provider_event_id  text pk,             -- svix-id (I3)
  received_at        timestamptz not null default now(),
  payload            jsonb not null,      -- InboundEvent normalizado + payload bruto
  outcome            text check (outcome in ('PROCESSED','CLARIFICATION_SENT','IGNORED_UNCLEAR','IGNORED_UNKNOWN_THREAD','IGNORED_SENDER','IGNORED_ALREADY_DECIDED')),  -- NULL = pendente
  approval_request_id uuid fk,
  classification     text,
  attempts           int not null default 0,
  lease_until        timestamptz,
  last_error         text,
  processed_at       timestamptz
)
index parcial: inbound_events (received_at) where outcome is null

actions (
  id          uuid pk,
  run_id      uuid not null fk runs,
  tool_use_id text not null,
  type        text not null check (type in ('REIMBURSEMENT_APPROVED','REIMBURSEMENT_REJECTED')),
  payload     jsonb not null,             -- { reason, amountCents, decidedBy: 'AGENT'|'HUMAN' }
  created_at,
  unique (run_id, tool_use_id)            -- I1
)

run_events (
  id      bigserial pk,
  run_id  uuid not null fk runs,
  at      timestamptz not null default now(),
  type    text not null,                  -- CREATED, CLAIMED, LEASE_LOST, RETRY_SCHEDULED, APPROVAL_REQUESTED,
                                          -- APPROVAL_SENT, DECISION_RECEIVED, RESUMED, ACTION_RECORDED,
                                          -- COMPLETED, FAILED, EXPIRED
  data    jsonb not null default '{}'
)
index: run_events (run_id, at)
```

Diferenças em relação ao rascunho do roadmap §5:
- `runs`: novas colunas `lease_token`, e `lease_until` com duplo papel.
- `approval_requests`: novas colunas `subject_token`, `summary`, `recommendation`, `decision_raw_text`, `provider_message_id`, `last_error`.
- `inbound_events`: `outcome` nulo significa pendente, e entram as colunas de processamento. Os outcomes novos são `CLARIFICATION_SENT` e `IGNORED_UNCLEAR`.
- Tabela nova: `run_events`.

A migration da F0 cria só `runs`. Cada fase cria as tabelas de que precisa.

## 5. Contrato de API

### 5.1 `POST /runs`

Request:

```json
{
  "description": "Hotel em SP para visita a cliente",
  "amountCents": 84000,
  "category": "TRAVEL",
  "requesterEmail": "ana@acme.test",
  "approverEmail": "gestor@acme.test"
}
```

Validação:
- `amountCents` é inteiro, maior que 0 e no máximo 100.000.000.
- `category` é um de `TRAVEL | MEALS | EQUIPMENT | TRAINING | OTHER`.
- Os e-mails são válidos e normalizados para minúsculas.
- `description` tem entre 1 e 2000 caracteres.

Respostas:
- `201 { "id": "<uuid>", "status": "PENDING" }`
- `400` com a lista de erros de validação.

A criação da run e o evento `CREATED` acontecem na mesma transação.

### 5.2 `GET /runs/:id`

Resposta `200`:

```json
{
  "id": "…", "status": "WAITING_APPROVAL", "input": { … },
  "attempts": 1, "lastError": null,
  "approval": { "status": "SENT", "decision": null, "note": null, "expiresAt": "…" },
  "action": null,
  "timeline": [ { "at": "…", "type": "CREATED", "data": {} }, … ]
}
```

- `approval` e `action` são nulos quando não existem.
- `timeline` vem de `run_events`, em ordem de `at`.
- `404` quando a run não existe. `400` quando o id não é um uuid.

### 5.3 `POST /webhooks/mail`

- Usa `rawBody: true` no bootstrap do Nest.
- `MailProvider.parseInbound(rawBody, headers)` verifica a assinatura Svix.
- Assinatura inválida ou ausente: `401` sem gravar nada.
- Evento que não é `message.received`: `200` sem gravar nada.
- Caso contrário:
  1. `INSERT INTO inbound_events ... ON CONFLICT (provider_event_id) DO NOTHING`;
  2. responde `200`, mesmo quando o evento é duplicado (I3).

O webhook não classifica nem decide. Isso fica com o processador (§8).

### 5.4 `GET /health`

Retorna `200 { "status": "ok" }` depois de um `SELECT 1` no banco. Se o banco estiver indisponível, retorna `503`.

O contrato é publicado em `docs/api/openapi.yaml`. A janela de contrato o escreve antes de qualquer implementação.

## 6. Worker e lease (F1)

### Claim

Uma única query, em autocommit, que também gera o token:

```sql
UPDATE runs SET status='RUNNING', lease_token=gen_random_uuid(),
       lease_until=now() + make_interval(secs => $LEASE_SECONDS), attempts=attempts+1, updated_at=now()
WHERE id = (
  SELECT id FROM runs
  WHERE (status='PENDING' AND (lease_until IS NULL OR lease_until <= now()))
     OR (status='RUNNING' AND lease_until < now())
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1)
RETURNING *;
```

- Um claim sobre uma run que estava `RUNNING` registra o evento `LEASE_LOST` (o dono anterior morreu ou travou).
- Se `attempts > MAX_ATTEMPTS` depois do claim, a run vai para `FAILED`. O `last_error` recebe `max attempts exceeded: <last_error anterior>`.

### Fencing

- Toda escrita do worker na run usa `WHERE id=$1 AND lease_token=$2 AND status='RUNNING'`.
- Se a escrita afetar 0 linhas, o repositório lança `LeaseLostError`, e o worker abandona a run sem efeitos adicionais.
- Efeitos fora da run são idempotentes por `unique`: `actions` e `approval_requests` (I1).

### Renovação

Cada persistência de passo (salvar `messages`) também faz `lease_until = now() + LEASE_SECONDS`. Não existe heartbeat separado.

### Erros

| Tipo | Exemplos | Efeito |
|---|---|---|
| Transitório | `RateLimitError`, `InternalServerError`, `APIConnectionError`, `stop_reason = max_tokens` | `status='PENDING'`, `lease_until = now() + backoff(attempts)` (exponencial, base 5s, teto 5min), `lease_token=null`, `last_error`, evento `RETRY_SCHEDULED` |
| Permanente | 400/401/404 da API, `stop_reason = refusal`, input inválido | `FAILED` com `last_error` |
| Desconhecido | qualquer outro | tratado como transitório; o limite de tentativas acaba em `FAILED` |

### Transições

Todas são guardadas (`updateMany` com status e/ou token esperados, checando o `count`) e registram um `run_event` na mesma transação.

### Configuração

| Variável | Padrão |
|---|---|
| `LEASE_SECONDS` | 120 |
| `MAX_ATTEMPTS` | 5 |
| `WORKER_POLL_MS` | 1000 |

A F1 usa um `AgentStep` stub que marca a run como `COMPLETED`, e a F2 o substitui pelo agente real.

## 7. Agente (F2)

### Loop

Cada passo acontece sobre a run claimada, com o token:

1. Carrega `messages`. Se estiver vazio, inicializa com a mensagem de usuário que descreve o pedido (JSON do input).
2. Se a última mensagem for `assistant` com `tool_use` e ainda não houver `tool_result` depois dela, executa a ferramenta, anexa o `tool_result` e persiste. As ferramentas são idempotentes.
   - **Exceção:** uma ferramenta que pausa a run (`request_approval`) não anexa `tool_result` nesse momento.
3. Chama `LlmClient.createMessage({ system, tools, messages, tool_choice: {type:'auto', disable_parallel_tool_use:true} })`. Checa `stop_reason` antes de ler o conteúdo.
4. Anexa `response.content` **inteiro e sem alterar** como mensagem `assistant` e persiste. O histórico é append-only, e o thinking é preservado.
5. Decide o próximo passo pelo `stop_reason`:
   - `tool_use`: volta ao passo 2.
   - `end_turn` com ação já gravada para a run: `COMPLETED`.
   - `end_turn` sem ação: `FAILED` com `agente terminou sem decisão`.
6. Com mais de `MAX_TURNS` (padrão 10) mensagens `assistant`, a run vai para `FAILED`.

"Persistir antes de executar a ferramenta" é consequência do passo 4: o `tool_use` já está gravado antes do passo 2 rodar.

### Ferramentas

As duas usam `strict: true` e `additionalProperties: false`.

**`request_approval({ summary, recommendation: 'APPROVE'|'REJECT', rationale })`**
- Numa transação:
  1. `INSERT approval_requests ... ON CONFLICT (run_id, tool_use_id) DO NOTHING`, com `status='CREATED'`, `expires_at = now() + APPROVAL_TTL_HOURS` e `approver_email` vindo do input;
  2. transição da run para `WAITING_APPROVAL` guardada pelo token, com `lease_token=null`, `lease_until=null` e `attempts=0` (I5);
  3. evento `APPROVAL_REQUESTED`.
- O worker encerra o processamento da run. O e-mail não é enviado aqui (§8).

**`record_decision({ decision: 'APPROVED'|'REJECTED', reason })`**
- Validação no código antes de gravar:
  - `APPROVED` com `amountCents > AUTO_APPROVE_LIMIT_CENTS` (padrão 50000) e sem approval `DECIDED`: `tool_result` com `is_error: true` e o texto "valor acima do limite: chame request_approval".
  - Com approval `DECIDED`, `decision` diferente da decisão humana: `tool_result` com `is_error: true`.
  - `REJECTED` abaixo do limite é permitido sem aprovação. O agente pode recusar sozinho, por exemplo por categoria inválida.
- Grava a ação com `INSERT actions ... ON CONFLICT (run_id, tool_use_id) DO NOTHING RETURNING`. Uma linha vazia significa que a ação já tinha sido executada, e o resultado é tratado como sucesso (I1).
- Registra o evento `ACTION_RECORDED` e devolve `tool_result` `{ ok: true }`.

### Retomada

- Condição: a run volta a `PENDING` (via decisão, §8) e a última mensagem é um `tool_use` de `request_approval` sem `tool_result`.
- O worker carrega o approval por `(run_id, tool_use_id)` e anexa o `tool_result`:

  ```json
  { "decision": "APPROVED", "note": "…", "decidedBy": "gestor@…" }
  ```

- Registra o evento `RESUMED` e continua no passo 3.
- Se o approval não estiver `DECIDED`, é erro de consistência e a run vai para `FAILED`.

### System prompt

Contém:
- o papel do agente;
- a regra: até R$ 500,00 o agente decide sozinho; acima disso, **sempre** chama `request_approval` antes de `record_decision`;
- depois da decisão humana, `record_decision` com a mesma decisão;
- valores em centavos.

O prompt é estável, sem timestamp, para permitir cache de prompt.

### `LlmClient`

- **Real:** `AnthropicLlmClient` usa `client.messages.create` com `thinking: {type:'adaptive'}`, `max_tokens: 16000` e `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). O SDK já faz os retries de 429/5xx (2 por padrão).
- **Fake:** `ScriptedLlmClient` devolve respostas roteirizadas por teste.

## 8. E-mail e inbound (F3/F4)

### `MailProvider`

```ts
interface MailProvider {
  send(p: { to: string; subject: string; text: string; html: string; idempotencyKey: string }): Promise<{ messageId: string; threadId: string }>;
  reply(p: { messageId: string; text: string; html: string; idempotencyKey: string }): Promise<{ messageId: string }>;
  parseInbound(rawBody: Buffer, headers: Record<string, string>): InboundEvent; // lança InvalidSignatureError
}
type InboundEvent = { eventId: string; type: string; threadId: string | null; messageId: string;
                      from: string; subject: string; text: string; raw: unknown };
```

- **Real:** `AgentMailProvider`.
  - A verificação usa `new Webhook(AGENTMAIL_WEBHOOK_SECRET).verify(rawBody, headers)` do pacote `svix`.
  - `eventId` é o `svix-id` e `text` é `extracted_text ?? text`.
  - `from` fica só com o endereço (tira o nome de `"Nome <e@x>"`) em minúsculas.
- **Fake:** `FakeMailProvider` registra os envios, permite injetar falha e gera eventos já "assinados" para os testes.

### Templates (tela do projeto)

Ficam em `mail/templates.ts` como funções puras.

**Pedido de aprovação**
- Assunto: `[mailgate #<subject_token>] Reembolso de R$ 840,00 — aprovação necessária`.
- Corpo em texto e HTML simples, contendo:
  - descrição, categoria, valor em BRL e solicitante;
  - resumo do agente;
  - recomendação do agente com a justificativa;
  - a instrução **"Responda este e-mail com APROVO ou RECUSO (pode incluir um comentário)."**;
  - prazo (`expires_at` formatado em pt-BR, America/Sao_Paulo).

**Esclarecimento**
- É uma resposta na mesma thread.
- Texto: "Não consegui entender sua resposta. Responda apenas APROVO ou RECUSO."

A janela de contrato renderiza exemplos dos dois em `docs/mocks/` e só fecha com a aprovação visual do usuário.

### Outbox de envio (F3)

A cada tick, o worker seleciona até 10 approval requests em `CREATED` (`OUTBOX_BATCH`), fora de transação. Para cada um:

1. `provider.send(..., idempotencyKey: 'approval-' + id)`.
2. Se der certo, `updateMany where id AND status='CREATED'` para `SENT`, gravando `provider_message_id` e `provider_thread_id`, e registra o evento `APPROVAL_SENT`.
3. Se falhar, grava `last_error` e o pedido continua em `CREATED` para o próximo tick.

O envio nunca acontece dentro de uma transação do banco. A chave de idempotência cobre crash entre envio e marcação, e também dois workers enviando o mesmo pedido, dentro da janela de 24h do provider (o risco 1 do roadmap §7 fica mitigado).

### Processador de inbound (F4)

A cada tick:

1. **Claim do evento.** Pega um evento com `outcome IS NULL AND attempts < MAX_ATTEMPTS AND (lease_until IS NULL OR lease_until < now())` usando `FOR UPDATE SKIP LOCKED` e faz `lease_until = now() + LEASE_SECONDS, attempts+1`.
   - O evento que esgota as tentativas fica com `outcome` nulo e `last_error`, fora do claim, e é registrado no log para inspeção manual. Não existe outcome terminal de falha.
2. **Correlação.**
   - Primeiro por `provider_thread_id = event.threadId`.
   - Se não achar, pelo `subject_token` extraído do assunto com a regex `\[mailgate #([a-z2-7]{8})\]`.
   - Sem correspondência: `IGNORED_UNKNOWN_THREAD`.
3. **Remetente.** Se `event.from` for diferente de `approver_email`: `IGNORED_SENDER` (I6).
4. **Pré-checagem sem lock.** Se o approval não estiver em `SENT`: `IGNORED_ALREADY_DECIDED`. Isso evita gastar LLM à toa. A checagem definitiva é a do passo 6.
5. **Classificação**, fora de transação. `ReplyClassifier.classify(text)` devolve `{ decision: 'APPROVED'|'REJECTED'|'UNCLEAR', note }`.
   - Real: `client.messages.parse` com `zodOutputFormat` e `effort: 'low'`. Se `parsed_output` vier nulo, o resultado é `UNCLEAR`.
   - O prompt instrui a responder `UNCLEAR` na dúvida.
6. **Decisão** (`APPROVED`/`REJECTED`), numa transação:
   - `SELECT ... FROM approval_requests WHERE id=$1 FOR UPDATE`;
   - se o status não for `SENT`: `IGNORED_ALREADY_DECIDED`;
   - senão:
     - o approval vai para `DECIDED`, com `decision`, `decision_note` e `decision_raw_text`;
     - a run faz `updateMany` de `WAITING_APPROVAL` para `PENDING` com `attempts=0` e `lease_until=null`;
     - evento `DECISION_RECEIVED`;
     - o `outcome` do evento inbound vira `PROCESSED`.
   - Se a run não estiver em `WAITING_APPROVAL`, a transação faz rollback. Isso é inconsistência e é registrado.
7. **`UNCLEAR`.**
   - Com `clarification_sent = false`:
     1. `provider.reply(messageId do evento, idempotencyKey: 'clarify-' + approvalId)`;
     2. `updateMany` de `clarification_sent` de `false` para `true`;
     3. outcome `CLARIFICATION_SENT`.
   - Com `clarification_sent = true`: outcome `IGNORED_UNCLEAR`.
   - A ordem (enviar e depois marcar) faz com que uma falha no envio leve a nova tentativa. A chave de idempotência faz dois `UNCLEAR` concorrentes gerarem um e-mail só.

O pedido já decidido não recebe resposta automática ao remetente. O roadmap marcava isso como opcional, e fica fora.

**Limite documentado:** o remetente pode ser forjado. O provider descarta mensagens que falham em SPF, DKIM ou DMARC, mas isso não é autenticação forte (README, na F6).

### Configuração

`AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET`, `APPROVAL_TTL_HOURS` (48).

Em desenvolvimento local, o webhook é exposto por um túnel (cloudflared ou ngrok).

## 9. Expiração (F5)

A cada `EXPIRY_INTERVAL_MS` (60000), o tick do worker roda numa transação:

```sql
SELECT id, run_id FROM approval_requests
WHERE status IN ('CREATED','SENT') AND expires_at < now()
FOR UPDATE SKIP LOCKED LIMIT 50;
```

Para cada linha:
- o approval vai para `EXPIRED` (guardado por status);
- a run faz `updateMany` de `WAITING_APPROVAL` para `EXPIRED`;
- evento `EXPIRED`.

Detalhes:
- `CREATED` também expira. Sem isso, um envio que falha para sempre deixaria a run presa.
- A corrida com a decisão se resolve pelo `FOR UPDATE` na linha do approval: só um vence. O `SKIP LOCKED` faz a expiração pular linhas que estão sendo decididas, e elas são reavaliadas no próximo tick.
- Uma run `EXPIRED` é terminal, o claim não a pega, e portanto nunca executa ação.

## 10. Testes

### Infraestrutura

- `globalSetup` sobe `postgres:16-alpine` via Testcontainers e roda `prisma migrate deploy`.
- `TRUNCATE ... RESTART IDENTITY CASCADE` no `beforeEach`.
- `--runInBand`.
- Nos testes de concorrência, cada "worker" tem seu próprio `PrismaClient`, e eles disparam juntos com `Promise.all`.
- `npm run test:stress` roda a suíte de concorrência 20 vezes e falha na primeira quebra (aceite da F1).

### Fakes

`ScriptedLlmClient`, `FakeMailProvider` e `FakeClassifier`. Nenhum teste de CI chama rede externa.

### Mapa de garantias

| Invariante | Teste |
|---|---|
| I1 | crash simulado depois do INSERT em `actions` e antes de persistir o `tool_result`: a run é reprocessada, `record_decision` é reexecutado com o mesmo `tool_use_id` e `actions` continua com 1 linha |
| I2 | duas respostas diferentes processadas em paralelo: 1 decisão; decisão × expiração em paralelo: exatamente um vencedor |
| I3 | mesmo `svix-id` entregue duas vezes: 1 linha em `inbound_events` e 1 decisão |
| I4 | N workers × M runs em paralelo: cada run é processada exatamente uma vez; worker com token velho recebe `LeaseLostError` e não escreve |
| I5 | depois de `request_approval`, a run está em `WAITING_APPROVAL` com lease nulo e o claim não a devolve |
| I6 | remetente diferente do aprovador: `IGNORED_SENDER` e approval continua `SENT` |

### Outros testes obrigatórios

- lease vencido é retomado;
- `MAX_ATTEMPTS` leva a `FAILED`;
- erro transitório agenda backoff;
- run até R$ 500 conclui sozinha;
- run acima de R$ 500 para em `WAITING_APPROVAL`;
- `record_decision` acima do limite sem aprovação devolve `is_error`;
- retomada anexa o `tool_result` certo;
- envio com sucesso marca `SENT`; falha no envio mantém `CREATED`;
- assinatura inválida devolve 401 sem gravar;
- thread desconhecida registra `IGNORED_UNKNOWN_THREAD`;
- fallback por `subject_token` funciona;
- `UNCLEAR` gera um esclarecimento só;
- resposta após expirar é ignorada;
- `CREATED` expira.

### Aceite manual

Fora do CI, e roteirizado em `docs/e2e.md`: AgentMail real, túnel, run acima de R$ 500 → e-mail → responder "pode aprovar" → run `COMPLETED` com uma linha em `actions`.

## 11. Ordem de entrega

1. **Contrato (design-first):**
   - `docs/api/openapi.yaml`;
   - templates de e-mail como funções puras com testes unitários;
   - exemplos renderizados em `docs/mocks/approval.html`, `approval.txt` e `clarification.txt`.

   Esta etapa só fecha com a aprovação visual do usuário.
2. **F0:**
   - projeto Nest, Prisma 7 e migration de `runs`;
   - Compose com `postgres`, `migrate` e `api`, e `GET /health`;
   - Jest com Testcontainers;
   - GitHub Actions (lint, typecheck, test);
   - README esqueleto.

   `git init` e o remote exigem autorização do usuário.
3. **F1:** runs, claim, fencing, retry e stub.
4. **F2:** agente.
5. **F3:** outbox de envio.
6. **F4:** webhook e processador.
7. **F5:** expiração.

## 12. Riscos

| Risco | Tratamento |
|---|---|
| E-mail duplicado por crash | Mitigado pelo `Idempotency-Key` (24h). O header não está na referência de send; o spike da F3 confirma |
| Thread quebrada por cliente de e-mail | Fallback por `subject_token` |
| `extracted_text` ausente no webhook | Usar `text`, e o classificador tolera o histórico citado |
| Remetente forjado | Checagem de remetente e SPF/DKIM/DMARC do provider. Documentado como limite |
| Classificador erra | `UNCLEAR` na dúvida; texto original e nota gravados |
| API do provider muda / SDK 0.x | Versão exata fixada, acesso isolado atrás de `MailProvider`, fake nos testes. Resend como plano B |
| Prisma 7 com Jest | Contorno `moduleNameMapper` e `moduleFormat` explícito |
