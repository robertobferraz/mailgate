# Roadmap — mailgate (nome provisório)

Human-in-the-loop durável para agentes de IA via e-mail.

Um agente executa uma tarefa, pausa num ponto de decisão, envia um e-mail pedindo aprovação e só retoma quando a resposta chega, mesmo que isso leve horas e o processo tenha reiniciado nesse meio-tempo.

Cada fase abaixo foi escrita para virar **uma spec** no fluxo SDD (requisitos → design → tarefas). As fases são sequenciais: cada uma depende da anterior estar concluída e testada.

---

## 1. Visão geral

### Cenário de demonstração

Uma empresa fictícia recebe pedidos de reembolso de despesas.

1. O agente analisa o pedido, que inclui descrição, valor e categoria.
2. Se o valor for até R$ 500, o agente aprova sozinho.
3. Acima de R$ 500, o agente envia um e-mail ao gestor com um resumo e a recomendação.
4. O gestor responde em linguagem natural, por exemplo "pode aprovar" ou "recusa, falta nota fiscal".
5. O agente retoma e registra a decisão, executando a ação simulada numa tabela `actions`.

Nenhum dinheiro real se move. O foco é a mecânica: pausa, retomada, duplicidade e expiração.

### O que o projeto precisa provar (critérios de portfólio)

- A execução sobrevive a restart, porque o estado está no banco e não na memória.
- Um webhook duplicado não gera efeito duplicado.
- Duas respostas ao mesmo pedido não geram duas decisões.
- Dois workers nunca processam a mesma execução ao mesmo tempo.
- Um pedido sem resposta expira de forma previsível.

### Stack

| Camada | Escolha | Motivo |
|---|---|---|
| Backend | NestJS (TypeScript) | Stack que você já domina |
| Banco | PostgreSQL 16 | Estado, fila (via `SKIP LOCKED`) e dedupe no mesmo lugar |
| Acesso a dados | Prisma **ou** o ORM que você já usa no trabalho | Decidir na F0; queries de claim usam SQL puro de qualquer forma |
| LLM | API do Claude com tool use | Provider e modelo configuráveis por env (`LLM_PROVIDER`, `LLM_MODEL`) |
| E-mail | AgentMail (ou outro provider com inbound via webhook) | Decidir na F3 após ler a doc atual |
| Testes | Jest + Testcontainers (Postgres real) | Concorrência não se testa com mock |
| Infra | Docker Compose + GitHub Actions | Um comando para subir; CI em todo push |

### Fora de escopo (projeto inteiro)

- Interface gráfica além de uma página simples de linha do tempo (opcional, F6).
- Suporte a mais de um provider de e-mail em produção.
- Multi-tenant, login ou painel administrativo.
- Autenticação forte do aprovador. E-mail não é prova forte de identidade; isso fica documentado como limite (ver Riscos aceitos).

---

## 2. Glossário

- **Run**: uma execução do agente para um pedido de reembolso, do início ao fim.
- **Approval request**: um pedido de aprovação enviado por e-mail dentro de uma run.
- **Tool use**: quando o modelo pede para executar uma ferramenta; a resposta volta como `tool_result`.
- **Lease**: "aluguel" temporário de uma run por um worker. Se o worker morrer, o lease vence e outro worker pode assumir.
- **Idempotência**: processar a mesma coisa duas vezes produz o mesmo efeito que processar uma vez.
- **Webhook**: requisição HTTP que o provider de e-mail faz para a nossa API quando chega uma resposta.
- **Correlação**: descobrir a qual approval request uma resposta pertence.

---

## 3. Invariantes

Todas as specs devem preservar estas regras, e cada uma precisa de pelo menos um teste que a comprove.

- **I1**: Uma ação do agente é executada no máximo uma vez por `(run_id, tool_use_id)`.
- **I2**: Um approval request recebe no máximo uma decisão.
- **I3**: Um evento de webhook é processado no máximo uma vez, identificado pelo id do evento no provider.
- **I4**: No máximo um worker processa uma run por vez.
- **I5**: Uma run em `WAITING_APPROVAL` não ocupa nenhum worker.
- **I6**: Só respostas vindas do endereço do aprovador cadastrado no pedido contam como decisão.

---

## 4. Modelo de estados

### Run

```
PENDING ──claim──▶ RUNNING ──pede aprovação──▶ WAITING_APPROVAL
   ▲                 │  │                          │        │
   │                 │  └──fim──▶ COMPLETED         │        └──expirou──▶ EXPIRED
   │                 └──erro irrecuperável──▶ FAILED│
   └────────────────────── decisão recebida ◀───────┘
```

- `PENDING`: pronta para ser pega por um worker. Serve tanto para o início quanto para a retomada.
- `RUNNING`: um worker detém o lease.
- Os estados terminais são `COMPLETED`, `FAILED` e `EXPIRED`.

### Approval request

```
CREATED ──enviado──▶ SENT ──resposta válida──▶ DECIDED (APPROVED | REJECTED)
                       │
                       └──expires_at passou──▶ EXPIRED
```

Resposta ambígua (`UNCLEAR`) não muda o estado. O sistema responde pedindo "aprovo" ou "recuso", no máximo uma vez por pedido.

---

## 5. Esquema de dados (rascunho)

```sql
runs (
  id uuid pk,
  status text not null,              -- PENDING | RUNNING | WAITING_APPROVAL | COMPLETED | FAILED | EXPIRED
  input jsonb not null,              -- pedido de reembolso
  messages jsonb not null,           -- histórico completo da conversa com o modelo
  attempts int not null default 0,
  lease_until timestamptz,
  last_error text,
  created_at, updated_at
)

approval_requests (
  id uuid pk,
  run_id uuid fk,
  tool_use_id text not null,         -- tool_use que pausou a run
  approver_email text not null,
  status text not null,              -- CREATED | SENT | DECIDED | EXPIRED
  decision text,                     -- APPROVED | REJECTED
  decision_note text,
  provider_thread_id text,           -- usado na correlação
  clarification_sent boolean not null default false,
  expires_at timestamptz not null,
  created_at, updated_at,
  unique (run_id, tool_use_id)
)

inbound_events (
  provider_event_id text pk,         -- I3
  received_at timestamptz not null,
  payload jsonb not null,
  outcome text                       -- PROCESSED | IGNORED_UNKNOWN_THREAD | IGNORED_SENDER | IGNORED_ALREADY_DECIDED
)

actions (
  id uuid pk,
  run_id uuid fk,
  tool_use_id text not null,
  type text not null,                -- REIMBURSEMENT_APPROVED | REIMBURSEMENT_REJECTED
  payload jsonb not null,
  created_at,
  unique (run_id, tool_use_id)       -- I1
)
```

---

## 6. Fases

### F0 — Fundação (~1 dia)

**Objetivo:** ter um repositório que sobe com um comando e tem CI verde.

**Requisitos**
- QUANDO o desenvolvedor executar `docker compose up`, o sistema DEVE subir a API e o Postgres, e `GET /health` DEVE retornar 200.
- QUANDO houver push ou PR, o CI DEVE executar lint, typecheck e testes.

**Tarefas**
1. Criar o projeto NestJS e definir o ORM. Registrar a decisão num ADR curto em `docs/adr/0001-orm.md`.
2. Criar `docker-compose.yml` com `api` e `postgres`.
3. Criar a primeira migration, contendo apenas a tabela `runs`.
4. Configurar Jest com Testcontainers e escrever um teste de integração trivial.
5. Criar o workflow do GitHub Actions.
6. Escrever o esqueleto do README com título, uma frase de descrição e Quickstart.

**Aceite:** clone limpo → `docker compose up` → health 200; CI verde.

---

### F1 — Runs e worker com lease (~2 dias)

**Objetivo:** executar runs de forma durável e concorrente sem LLM ainda. O passo do agente é um stub que conclui a run.

**Requisitos**
- QUANDO um cliente chamar `POST /runs` com um pedido válido, o sistema DEVE criar a run em `PENDING` e retornar o id.
- QUANDO um cliente chamar `GET /runs/:id`, o sistema DEVE retornar o status e a linha do tempo básica.
- ENQUANTO houver runs `PENDING`, o worker DEVE pegá-las com lease de N segundos. (I4)
- SE o lease de uma run `RUNNING` vencer, ENTÃO ela DEVE voltar a ser elegível.
- SE uma run falhar mais que `MAX_ATTEMPTS` vezes, ENTÃO ela DEVE ir para `FAILED` com `last_error`.

**Notas de design**
- O claim é feito numa única query:

  ```sql
  UPDATE runs SET status='RUNNING', lease_until=now()+interval '60s', attempts=attempts+1
  WHERE id = (
    SELECT id FROM runs
    WHERE status='PENDING' OR (status='RUNNING' AND lease_until < now())
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
  ```

- O worker roda no mesmo processo da API, num loop com intervalo. Não precisa de Redis nem de fila externa.
- Toda transição de status usa `WHERE status = <esperado>`, para que uma transição concorrente falhe em vez de sobrescrever.

**Tarefas**
1. Criar os endpoints `POST /runs` e `GET /runs/:id` com validação do input.
2. Implementar a query de claim e o loop do worker.
3. Implementar as transições com guarda de status.
4. Escrever os testes: dois workers em paralelo nunca pegam a mesma run (I4); lease vencido é retomado; limite de tentativas leva a `FAILED`.

**Aceite:** os testes de concorrência passam de forma estável em 20 execuções seguidas.

---

### F2 — Agente com pausa por ferramenta (~2 dias)

**Objetivo:** trocar o stub pelo loop real de tool use, com pausa e retomada baseadas no histórico persistido.

**Requisitos**
- O agente DEVE ter duas ferramentas:
  - `request_approval(summary, recommendation)`, que pausa a run.
  - `record_decision(decision, reason)`, que grava em `actions`.
- QUANDO o modelo chamar `request_approval`, o sistema DEVE criar o approval request em `CREATED`, mover a run para `WAITING_APPROVAL` e liberar o worker. (I5)
- QUANDO a run for retomada, o sistema DEVE reconstruir a conversa a partir de `runs.messages` e anexar o `tool_result` com a decisão humana.
- QUANDO o modelo chamar `record_decision`, o sistema DEVE inserir em `actions` usando `unique (run_id, tool_use_id)`. Em caso de conflito, DEVE tratar como já executado. (I1)
- SE o valor for até R$ 500, o agente PODE decidir sem pedir aprovação. Essa regra fica no system prompt **e** é validada no código antes de gravar a ação.

**Notas de design**
- `runs.messages` é salvo **antes** de executar cada ferramenta. Assim, um crash depois da ferramenta leva à reexecução do mesmo `tool_use_id`, e o `unique` impede o efeito duplicado.
- Nos testes, a API do Claude é substituída por um fake que devolve respostas roteirizadas. Isso deixa os testes determinísticos e sem custo.

**Tarefas**
1. Implementar o cliente da API do Claude e o loop de tool use.
2. Implementar a persistência do histórico antes de cada ferramenta.
3. Implementar as duas ferramentas e a validação da regra de R$ 500 no código.
4. Escrever os testes: pausa libera o worker; retomada continua do ponto certo; crash simulado após `record_decision` não duplica a ação.

**Aceite:** uma run abaixo de R$ 500 conclui sozinha; uma run acima para em `WAITING_APPROVAL`.

---

### F3 — Envio do pedido por e-mail (~1 dia)

**Objetivo:** mandar o e-mail de aprovação de forma confiável.

**Requisitos**
- QUANDO existir approval request em `CREATED`, o sistema DEVE enviar o e-mail e marcá-lo como `SENT`, gravando `provider_thread_id`.
- SE o envio falhar, ENTÃO o pedido DEVE continuar em `CREATED` para nova tentativa.
- O e-mail DEVE conter o resumo, a recomendação do agente, o valor e a instrução "responda aprovo ou recuso".

**Notas de design**
- Criar uma interface `MailProvider` com dois métodos, `send` e `parseInbound`. Ela existe por uma necessidade concreta: os testes usam um fake. Não é para suportar vários providers.
- Antes de implementar, ler a doc atual do provider e confirmar três pontos: como obter o thread id; se o envio aceita chave de idempotência; como o webhook é assinado.
- **Risco aceito:** se o processo cair entre o envio e a marcação `SENT`, o e-mail pode sair duas vezes. Se o provider aceitar chave de idempotência, usar o id do approval request como chave. Se não aceitar, documentar o risco. O impacto é o gestor receber duas cópias, e a I2 continua protegendo a decisão.

**Tarefas**
1. Criar a interface `MailProvider`, a implementação real e o fake.
2. Implementar o envio disparado pelo worker, sem enviar dentro da transação do banco.
3. Escrever os testes: sucesso marca `SENT`; falha mantém `CREATED`.

**Aceite:** com o provider real, o e-mail chega na caixa de teste.

---

### F4 — Webhook de resposta (~2 dias) ★ fase central do portfólio

**Objetivo:** receber a resposta, garantir exatamente uma decisão e retomar a run.

**Requisitos**
- O sistema DEVE verificar a assinatura do webhook. Se for inválida, DEVE responder 401 sem gravar nada.
- QUANDO um evento chegar, o sistema DEVE inserir em `inbound_events`. Se `provider_event_id` já existir, DEVE responder 200 sem processar. (I3)
- SE o thread não corresponder a nenhum approval request, ENTÃO o sistema DEVE registrar `IGNORED_UNKNOWN_THREAD` e responder 200.
- SE o remetente não for o `approver_email`, ENTÃO o sistema DEVE registrar `IGNORED_SENDER` e não decidir. (I6)
- QUANDO a resposta for válida, o sistema DEVE classificá-la como `APPROVED`, `REJECTED` ou `UNCLEAR` usando o LLM com saída estruturada.
- QUANDO a classificação for `APPROVED` ou `REJECTED`, o sistema DEVE, numa única transação, travar o approval request, conferir que está `SENT`, gravar a decisão e mover a run para `PENDING`. (I2)
- SE o pedido já estiver `DECIDED` ou `EXPIRED`, ENTÃO o sistema DEVE registrar `IGNORED_ALREADY_DECIDED`. Opcionalmente, pode responder ao remetente informando a decisão já tomada.
- QUANDO a classificação for `UNCLEAR` e `clarification_sent = false`, o sistema DEVE enviar um e-mail pedindo "aprovo" ou "recuso" e marcar a flag.

**Notas de design**
- O webhook não chama o agente. Ele só registra a decisão e devolve a run para `PENDING`, e o worker retoma depois. Assim o webhook responde rápido e o provider não reenvia por timeout.
- A classificação por LLM acontece fora da transação. Se a mesma run receber duas respostas quase simultâneas, a trava da transação garante que só a primeira vence.
- **Limite documentado:** o remetente de um e-mail pode ser forjado. Registrar os resultados de SPF/DKIM se o provider os expuser e deixar claro no README que isso não é autenticação forte.

**Tarefas**
1. Criar o endpoint `POST /webhooks/mail` com verificação de assinatura.
2. Implementar o dedupe via `inbound_events`.
3. Implementar a correlação por `provider_thread_id` e a checagem de remetente.
4. Implementar o classificador com saída estruturada, usando fake nos testes.
5. Implementar a transação de decisão com guarda de status.
6. Implementar o e-mail de esclarecimento.
7. Escrever os testes:
   - mesmo evento duas vezes → uma decisão (I3);
   - duas respostas diferentes em paralelo → uma decisão (I2);
   - remetente errado → nenhuma decisão (I6);
   - resposta após expirar → ignorada;
   - `UNCLEAR` → um único esclarecimento.

**Aceite:** fluxo ponta a ponta com provider real — criar run acima de R$ 500 → e-mail → responder "pode aprovar" → run `COMPLETED` com uma linha em `actions`.

---

### F5 — Expiração (~0,5 dia)

**Requisitos**
- A cada minuto, o sistema DEVE mover os approval requests `SENT` com `expires_at < now()` para `EXPIRED` e as runs deles para `EXPIRED`, na mesma transação e com guarda de status.
- Uma run expirada NÃO DEVE executar nenhuma ação.

**Tarefas**
1. Criar o job agendado, usando `@nestjs/schedule` ou o próprio loop do worker.
2. Escrever os testes: expiração correta; corrida entre expiração e resposta → só um dos dois vence.

---

### F6 — Demonstração e publicação (~1,5 dia)

**Tarefas**
1. Fazer o deploy num serviço com Postgres gerenciado e URL pública para o webhook.
2. Completar o README com:
   - descrição e badges;
   - GIF do fluxo (terminal e caixa de e-mail);
   - Quickstart em até 3 passos;
   - diagrama de estados em Mermaid;
   - a seção "Garantias", listando I1–I6 com o teste que prova cada uma;
   - a seção "Limites conhecidos".
3. Opcional: criar uma página `GET /runs/:id/timeline` em HTML simples para o GIF.
4. Adicionar a licença MIT.
5. Publicar os posts no LinkedIn:
   - **Post 1 (arquitetura):** o problema do agente que precisa esperar um humano, com o diagrama de estados.
   - **Post 2 (bastidor):** "o que acontece quando o webhook chega duas vezes", com o teste que prova.
   - **Post 3 (lançamento):** vídeo de 30s e link do repositório.

---

## 7. Riscos aceitos e limites

| Risco | Probabilidade | Impacto | Tratamento |
|---|---|---|---|
| E-mail duplicado por crash entre envio e `SENT` | Baixa (exige crash nessa janela) | Baixo: gestor recebe 2 cópias | Chave de idempotência se o provider suportar; senão, documentar |
| Remetente forjado | Baixa na demo | Alto num cenário real | Checagem de remetente + SPF/DKIM se disponível; documentado como limite |
| Classificador interpreta errado | Desconhecida | Médio | Saída estruturada, `UNCLEAR` como padrão na dúvida, decisão e texto original gravados |
| Mudança na API do provider | Desconhecida | Médio | Acesso isolado atrás de `MailProvider`; o fake mantém os testes independentes |

---

## 8. Cronograma

| Fase | Dias úteis | Acumulado |
|---|---|---|
| F0 Fundação | 1 | 1 |
| F1 Runs e worker | 2 | 3 |
| F2 Agente | 2 | 5 |
| F3 Envio | 1 | 6 |
| F4 Webhook | 2 | 8 |
| F5 Expiração | 0,5 | 8,5 |
| F6 Publicação | 1,5 | 10 |

Se o prazo apertar, a F4 é a que não pode ser cortada. A página de timeline (F6) e o e-mail de esclarecimento (F4) são os primeiros candidatos a sair.
