# mailgate — design (F6 + hardening)

- **Data:** 2026-09-23
- **Status:** em revisão
- **Fontes:**
  - Roadmap: `docs/roadmap.md` §6 F6, citado por seção.
  - Backlog: `docs/00-backlog/0001` a `0010`.
  - Pesquisa: `.claude/sdd/f6-hardening/RESEARCH.md` (Q1–Q6).
  - Workstream anterior: `docs/superpowers/specs/mailgate/design.md` (F0–F5). As decisões ativas dele continuam valendo, exceto D019, que este workstream derruba.
- **Escopo:** fechar os itens 0001 a 0010 do backlog e publicar o projeto. Os posts no LinkedIn ficam fora: o usuário faz à mão.

## 1. Objetivo

Deixar o mailgate publicável: rodando numa URL pública, com README que mostra o fluxo em GIF, licença MIT e sem as arestas que as revisões de F0–F5 deixaram registradas no backlog.

O sucesso tem quatro partes:
- cada item de hardening (0005, 0006, 0007, 0009, 0010) tem um teste contra Postgres real que falha antes e passa depois;
- as invariantes I1 a I6 continuam passando, incluindo o stress de 20 execuções;
- os dois GIFs saem de um único script, sem LLM nem e-mail reais;
- o deploy responde `GET /health` 200 numa URL HTTPS pública, e o webhook do AgentMail aponta para ela.

## 2. Itens e comportamento

### 2.1 Resposta a pedido já decidido ou expirado (backlog 0002 · derruba D019)

- QUANDO chegar uma resposta do remetente cadastrado (I6) a um approval em `DECIDED` ou `EXPIRED`, o sistema DEVE responder no mesmo thread informando o estado: aprovado ou recusado com a data da decisão, ou expirado com a data do prazo.
- O sistema DEVE responder no máximo uma vez por approval, usando a flag nova `late_reply_sent`. Mesmo padrão do esclarecimento: envia primeiro com `Idempotency-Key late-<approvalId>` e depois vira a flag com `updateMany where late_reply_sent = false`.
- Remetente diferente do cadastrado continua `IGNORED_SENDER`, sem resposta.
- O envio acontece fora de transação (convenção 0004). O caminho que descobre o estado já decidido dentro da transação de decisão (corrida) só registra o outcome. A resposta tardia sai depois do commit.
- O outcome continua `IGNORED_ALREADY_DECIDED`, ou `IGNORED_EXPIRED` quando o approval expirou (2.5).
- Template novo `renderLateReplyEmail`, função pura em `src/mail/templates.ts`, com mock renderizado em `docs/mocks/` e spec de tela em `docs/01-specs/`. Direção visual da PDR 0004.

### 2.2 Página de linha do tempo (backlog 0003 · Q6)

- `GET /runs/:id/timeline` devolve HTML (`text/html; charset=utf-8`). Uuid inválido dá 400, run desconhecida dá 404.
- Uma função pura `renderTimelinePage(view)` em `src/runs/timeline-page.ts` recebe a view de `RunsService.getView()`, sem template engine.
- Conteúdo:
  - cabeçalho com status, valor em destaque, descrição, categoria e tentativas;
  - bloco do approval com recomendação e prazo;
  - lista de `run_events` em ordem (`at`, `id`), com horário em Brasília (`formatDeadline`), rótulo em português por tipo e detalhe curto.
- **Mascaramento (só na página):**
  - e-mail do aprovador vira `g***@dominio.com`;
  - `last_error` e o erro de `FAILED`/`RETRY_SCHEDULED` mostram só a classe do erro (`transitório` ou `permanente`), nunca o texto cru.
  
  O JSON de `GET /runs/:id` não muda.
- `<meta http-equiv="refresh" content="2">` só enquanto a run não é terminal (`COMPLETED`, `FAILED`, `EXPIRED`).
- Cabeçalhos: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` e `X-Content-Type-Options: nosniff`.
- `escapeHtml` sai de `templates.ts` para um módulo compartilhado e passa a escapar `'`. Toda string vinda de input, nota ou evento passa por ele.

### 2.3 Graceful shutdown (backlog 0005 · Q5)

O fix descrito no backlog não funciona: o Nest roda `onModuleDestroy` (onde o Prisma desconecta) antes de `beforeApplicationShutdown`.

- `PrismaService` passa a desconectar em `onApplicationShutdown`.
- `WorkerLoop.beforeApplicationShutdown`:
  - para os timers e marca `stopping`;
  - guarda as promises de `tickRuns` e `tickSide`;
  - espera as duas com teto de `SHUTDOWN_GRACE_MS` (padrão 8000).
- `tickRuns` confere `stopping` antes de cada `processNextRun`, para não pegar run nova durante o shutdown.
- Se o teto estourar, um `AbortController` do `WorkerService` aborta a chamada LLM em voo, e a run é liberada sem consumir tentativa:
  - método novo de repositório, com fencing por `lease_token`: `lease_until = now()`, `attempts = attempts - 1`, status `PENDING`;
  - o erro de abort é uma classe própria, nem transitória nem permanente;
  - o SDK recebe `signal` por chamada.
- `docker-compose.yml` ganha `stop_grace_period: 15s` no serviço `api`. A config valida `SHUTDOWN_GRACE_MS` < 15000.
- A mesma drenagem cobre outbox, inbound e expiry, que rodam em `tickSide`. Isso fecha a janela de e-mail duplicado entre o aceite do provider e a marcação `SENT`.

### 2.4 RESUMED idempotente (backlog 0006)

- `RESUMED` passa a ser gravado na mesma transação que salva o `tool_result` com fencing (D006).
- Uma lease perdida ou um crash entre os dois passos não duplica mais o evento: ou os dois gravam, ou nenhum grava.

### 2.5 Expiração exata (backlog 0010)

- A transação de decisão (I2) exige `status = 'SENT' AND expires_at > now()` na linha travada. Uma resposta depois do prazo, mesmo antes de o job de expiração rodar, vira `IGNORED_EXPIRED`.
- O outbox passa a pegar cada `CREATED` com `FOR UPDATE SKIP LOCKED` numa transação curta, conferindo `status = 'CREATED' AND expires_at > now()`. Um approval que o expiry acabou de virar não é enviado.
  - O envio continua fora da transação (convenção 0004).
  - A linha é "reservada" com um lease curto (`send_lease_until`) antes do envio.
  - Enviar primeiro e marcar depois (D016) continua valendo.
- `ExpiryService.expireDue` repete a passada enquanto o lote vier cheio (`BATCH`), em transações separadas por lote.
- Migração: `IGNORED_EXPIRED` entra no CHECK de `inbound_events.outcome`.

### 2.6 Dead-letter de inbound (backlog 0009)

- Quando `processNext` registra um erro e `attempts >= MAX_ATTEMPTS`, o evento recebe outcome `FAILED` e o `last_error` é mantido. O processador também loga com nível `error`.
- `setOutcome` passa a ter a guarda `outcome IS NULL`, com `updateMany` e `count`. Um re-claim não sobrescreve mais o outcome gravado.
- Migração: `FAILED` entra no CHECK de `inbound_events.outcome`.

### 2.7 Backoff do outbox (backlog 0007)

- Colunas novas em `approval_requests`: `send_attempts int not null default 0` e `next_send_at timestamptz`.
- Cada falha de envio incrementa `send_attempts` e define `next_send_at = now() + least(30s × 2^(send_attempts-1), 1h)`, usando o relógio do banco (convenção 0003).
- O outbox só pega `CREATED` com `next_send_at IS NULL OR next_send_at <= now()`.
- O fim da linha continua sendo a expiração (D013). Não existe estado "falhou de vez" para o envio.

### 2.8 npm audit (backlog 0004 · Q4)

- `overrides: { "mysql2": "^3.24.4" }` no `package.json`. Isso limpa GHSA-3f6p-5ww8-9rcr e GHSA-rgwj-5xj2-c3m3.
- O lockfile é regerado dentro de `node:22-alpine` (lição 0002), e a verificação é `docker compose up --build`, incluindo `migrate`.
- `deepmerge-ts` 7.1.5 (GHSA-ggr8-5vv4-36mx) fica como risco aceito em ADR até o Prisma 8 estável. Só entra no caminho config → CLI, com input confiável.

### 2.9 Adapter OpenAI-compatible (backlog 0008 · Q3)

- `LLM_PROVIDER` ganha o valor `openai-compatible`, que exige `LLM_API_KEY`. `LLM_BASE_URL` é opcional: ausente, usa a OpenAI.
- `OpenAiLlmClient` implementa a porta `LlmClient` e devolve `Anthropic.Message`, preservando o histórico append-only (convenção 0005).
- Usa o SDK `openai` com versão exata, `chat.completions`, `maxRetries: 0` e `timeout: LLM_TIMEOUT_MS`.
- A tradução fica em funções puras (`toChatRequest`, `fromChatCompletion`), com a tabela de mapeamento de RESEARCH Q3:
  - `parallel_tool_calls: false`, e só o primeiro `tool_use` é mantido;
  - `arguments` inválido vira `input: {}`;
  - `max_completion_tokens`;
  - campo `reasoning` ignorado;
  - `thinking` omitido no envio.
- O classificador ganha `OpenAiReplyClassifier`, com `response_format: json_schema` e `strict` controlado por `LLM_STRICT_OUTPUT` (padrão `false`). Mantém `safeParse` Zod e fallback `UNCLEAR`.
- A escolha da implementação fica nas factories de `agent.module.ts` e `inbound.module.ts`.

### 2.10 Modo demo e GIFs (backlog 0001 · Q2)

- Com `DEMO=true`, as factories dos módulos trocam LLM, classificador e `MailProvider` por implementações demo em `src/demo/`, promovidas de `test/fakes/`:
  - **LLM roteirizado:** acima de `AUTO_APPROVE_LIMIT_CENTS` pede aprovação, abaixo decide sozinho;
  - **classificador por palavra-chave:** "aprovo"/"pode aprovar" → APPROVED, "recuso" → REJECTED, o resto → UNCLEAR;
  - **mail demo:** loga e guarda os envios, mas o `parseInbound` é o do AgentMail, com verificação svix real.
- `DEMO=true` é recusado pela config quando `NODE_ENV=production`.
- Os testes passam a importar os fakes de `src/demo/` quando forem iguais. Os que forem só de teste continuam em `test/fakes/`.
- `scripts/demo-reply.ts` monta o payload de resposta, assina com `new Webhook(secret).sign(...)` do svix e faz POST em `/webhooks/mail`. O subject token sai do mail demo (log ou endpoint só-demo `GET /demo/outbox`, registrado só com `DEMO=true`).
- `scripts/record-demo.sh`:
  - sobe o Postgres pelo compose e a API com `DEMO=true`;
  - roda `vhs docs/demo/terminal.tape` para gerar `docs/assets/demo-terminal.gif`;
  - roda o script Playwright que grava a timeline e converte com ffmpeg + gifski para `docs/assets/demo-timeline.gif`.
  
  Alvo de 2–5 MB por GIF, 800–1000 px de largura, 10–15 fps.
- Pré-requisitos locais (`brew install vhs gifski ffmpeg`, Playwright como devDependency) documentados no README, seção Development.

### 2.11 Publicação (backlog 0001 · Q1)

- `LICENSE` MIT e `"license": "MIT"` no `package.json`.
- O README ganha:
  - os dois GIFs;
  - link para a demo pública;
  - Quickstart em até 3 passos;
  - o limite de privacidade da timeline;
  - a seção de deploy.
  
  Guarantees e Known limits já existem e são atualizados.
- Deploy no Northflank Developer Sandbox, com um serviço a partir do `Dockerfile` e um addon Postgres 16.
  - Start `sh -c "npx prisma migrate deploy && node dist/main.js"`, health `GET /health`, 1 instância, `DB_POOL_MAX=3`.
  - Webhook do AgentMail em `https://<url>/webhooks/mail`.
  - Plano B: Railway Hobby.
- Guia em `docs/deploy.md` com o passo a passo. **Quem cria a conta e cadastra os secrets é o usuário**: a IA não cria conta nem digita credencial.

## 3. Dados (uma migração por janela que muda esquema)

| Tabela | Mudança | Item |
|---|---|---|
| `approval_requests` | `late_reply_sent boolean not null default false` | 2.1 |
| `approval_requests` | `send_attempts int not null default 0`, `next_send_at timestamptz`, `send_lease_until timestamptz` | 2.5, 2.7 |
| `inbound_events` | CHECK de `outcome` ganha `IGNORED_EXPIRED` e `FAILED` | 2.5, 2.6 |

## 4. Configuração nova

| Env | Padrão | Regra |
|---|---|---|
| `SHUTDOWN_GRACE_MS` | 8000 | < 15000 (`stop_grace_period`) |
| `LLM_PROVIDER` | `anthropic` | + `openai-compatible` (exige `LLM_API_KEY`) |
| `LLM_STRICT_OUTPUT` | `false` | só vale para `openai-compatible` |
| `DEMO` | `false` | proibido com `NODE_ENV=production` |

## 5. Testes

- **Integração (Testcontainers), um por comportamento:**
  - resposta tardia uma vez só, com duas respostas tardias gerando um envio;
  - remetente errado sem resposta tardia;
  - timeline com XSS escapado, CSP presente, 400 e 404, e sem meta refresh em run terminal;
  - shutdown aguarda o tick, e o abort libera o lease sem gastar tentativa;
  - `RESUMED` único com crash simulado entre os passos;
  - resposta após `expires_at` antes do job gera `IGNORED_EXPIRED`;
  - corrida entre outbox e expiry não envia;
  - expiry drena mais que `BATCH` num tick;
  - inbound esgotado vira `FAILED`, e o outcome não é sobrescrito;
  - backoff respeita `next_send_at`.
- **Unitários:**
  - `toChatRequest` e `fromChatCompletion` (tabela de mapeamento, ids, JSON inválido, múltiplos `tool_calls`);
  - `renderTimelinePage` (escape, mascaramento);
  - `renderLateReplyEmail`;
  - config (`DEMO` em produção, grace, `openai-compatible` sem key).
- Stress: `npm run test:stress` continua verde em 20 execuções.

## 6. Ordem de entrega (design first)

1. **Telas:** spec e mock do e-mail de resposta tardia e da página de timeline, com dados mascarados. Fecha com aprovação visual explícita do usuário.
2. **Hardening:** 2.3, 2.4, 2.5, 2.6, 2.7 e 2.8.
3. **Resposta tardia e timeline:** 2.1 e 2.2 no backend.
4. **Adapter OpenAI:** 2.9.
5. **Publicação:** 2.10 e 2.11.

## 7. Fora de escopo

- Posts no LinkedIn.
- Autenticação da API ou da timeline. A timeline só mascara.
- Upgrade para Prisma 8.
- SSE ou atualização da timeline via JavaScript.
- Responses API da OpenAI.

## 8. Riscos

| Risco | Tratamento |
|---|---|
| Northflank Sandbox exige cartão ou tem pouca memória | Plano `nf-compute-20` (US$5,40/mês) ou Railway Hobby |
| Modelo do Groq sem `strict` devolve JSON fora do schema | `safeParse` → `UNCLEAR`, que é o caminho seguro já existente |
| Resposta tardia em loop com auto-responder | Uma resposta por approval (`late_reply_sent`) |
| Timeline pública expõe dados | Mascaramento na página e limite documentado no README |
