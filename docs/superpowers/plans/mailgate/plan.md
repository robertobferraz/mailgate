# mailgate (F0–F5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a NestJS service in which an AI agent reviews reimbursement requests. It pauses to ask a manager for approval by e-mail and resumes durably when the reply arrives, which can happen hours later. I1–I6 are proven by tests against a real Postgres.

**Architecture:**
- A single NestJS process runs both the HTTP API and a polling worker loop.
- Postgres is the queue. Runs are claimed with `FOR UPDATE SKIP LOCKED` and hold a lease with a fencing token.
- The Claude tool-use loop persists history before any tool runs. It pauses on `request_approval` and resumes when a reply-driven decision moves the run back to `PENDING`.
- E-mail goes through a `MailProvider` port (AgentMail in production, a fake in tests):
  - an outbox sends approval requests;
  - the webhook only stores events;
  - a worker-side processor classifies replies and decides.

**Tech Stack:** Node 22, NestJS 11, TypeScript (strict, CJS), Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`), PostgreSQL 16, `@anthropic-ai/sdk`, `agentmail`, `svix`, `zod`, Jest + ts-jest + `@testcontainers/postgresql` + supertest, Docker Compose, GitHub Actions.

**Spec:**
- `/Users/roberto/Documents/mailgate/.claude/sdd/mailgate/CONTRACT.md`: decisions D001–D021.
- `/Users/roberto/Documents/mailgate/docs/superpowers/specs/mailgate/design.md`: approved design.
- Also read:
  - `docs/roadmap.md`;
  - `.claude/sdd/mailgate/RESEARCH.md`;
  - `docs/01-specs/`, `docs/02-adr/`, `docs/03-pdr/`;
  - `docs/04-conventions/README.md`, before writing any code.

## Global Constraints

- **Node:** 22 LTS, in CI, in the Dockerfile and locally. Prisma 7 needs ≥ 20.19. Do not use Node 24 (AgentMail SDK WebSocket issue #12).
- **Pinned versions:**
  - Prisma is `7.x`, pinned exact (`npm i -E`). Never install Prisma 8.
  - `agentmail` is pinned to an exact version.
- **Money:** integer cents only. `AUTO_APPROVE_LIMIT_CENTS=50000` is inclusive: `amountCents <= 50000` may be auto-approved.
- **Env defaults:**
  - Worker and lease: `LEASE_SECONDS=120`, `MAX_ATTEMPTS=5`, `MAX_TURNS=10`, `WORKER_POLL_MS=1000`, `WORKER_ENABLED=true`.
  - Approval: `APPROVAL_TTL_HOURS=48`, `EXPIRY_INTERVAL_MS=60000`, `OUTBOX_BATCH=10`.
  - Claude: `ANTHROPIC_MODEL=claude-opus-5`, `ANTHROPIC_FALLBACK=default`.
  - Other: `DB_POOL_MAX=10`, `PORT=3000`.
- **Status columns:** `text` + `CHECK`, never Prisma enums (D020).
- **Timestamps:** every timestamp is `@db.Timestamptz(3)`. Lease, backoff and expiry math uses the DB `now()`, never `new Date()` (convention 0003).
- **Transactions:**
  - No LLM or e-mail call inside `$transaction` (convention 0004).
  - No `create` + catch P2002 inside a transaction (convention 0002).
- **Worker writes:** every worker write to `runs` filters by `id` + `lease_token` + `status`, and 0 rows means `LeaseLostError` (convention 0001).
- **Claude history:** append-only. Store `response.content` verbatim (convention 0005).
- **Idempotency keys:** `approval-<approvalId>` for send and `clarify-<approvalId>` for the clarification reply.
- **Subject format:** `[mailgate #<subject_token>] Reembolso de R$ <valor> — aprovação necessária`. The token is 8 chars from `a-z2-7`.
- **CI:** no test in CI may touch the network except Docker for Testcontainers. LLM, mail and classifier are always faked.
- **Language:** repo docs (`docs/**`) are in English. E-mail copy and agent prompts are in pt-BR.
- **Git:**
  - **Never commit without the user asking.** Every "Checkpoint" step means: stop, report, and ask the user whether to commit.
  - **Do not `git init` or create a remote without the user's explicit authorization.**
- **Repository layer:** repositories take `@Inject(PrismaService) prisma: PrismaClient`, so tests can pass a plain `PrismaClient`.

## Review Focus

1. **Reply `From` with display name or uppercase.** `From: "Gestor <GESTOR@ACME.TEST>"` must match approver `gestor@acme.test`. Tests go in Task 13 (`toInboundEvent`) and Task 17 (processor).
2. **Amount exactly at the limit.** `amountCents = 50000` must be approvable by the agent alone. Test in Task 11.
3. **Model calls `record_decision` twice with different tool_use ids.** The second call must be rejected with `is_error`, leaving exactly one action. Test in Task 11.
4. **Signed webhook without `thread_id`.** It is stored anyway and correlated through the subject token. Tests in Task 15 and Task 17.
5. **`amountCents` sent as a float (`840.5`) or a numeric string (`"84000"`).** Must return 400 and never be coerced. Test in Task 6.

---

## File Structure

```
package.json, tsconfig.json, tsconfig.build.json, nest-cli.json, eslint.config.mjs
jest.config.js                 unit tests: src/**/*.spec.ts
jest.int.config.js             integration: test/**/*.int-spec.ts (Testcontainers)
prisma.config.ts, prisma/schema.prisma, prisma/migrations/*
Dockerfile, .dockerignore, docker-compose.yml, .env.example
.github/workflows/ci.yml
scripts/render-mocks.ts        renders e-mail mocks into docs/mocks/
scripts/stress.sh              runs *.concurrency.int-spec.ts 20×
scripts/agentmail-spike.ts     manual spike against the real provider
docs/api/openapi.yaml          API contract
docs/mocks/                    rendered e-mails for visual approval
docs/e2e.md                    manual end-to-end script
src/
  main.ts, app.module.ts
  config/config.ts, config/config.module.ts           typed env (zod), APP_CONFIG token
  prisma/prisma.service.ts, prisma/database.module.ts  PrismaService + repositories (global)
  prisma/db.ts                                         Db = PrismaClient | TransactionClient
  generated/prisma/                                    Prisma client output (generated, not edited)
  health/health.controller.ts, health/health.module.ts
  runs/reimbursement-input.ts   zod schema + types (the contract data)
  runs/run.ts                   Run, Lease, RunStatus, LeaseLostError, row mappers
  runs/run-events.ts            appendRunEvent
  runs/run.repository.ts        create, find, claim, fenced transitions
  runs/runs.service.ts, runs/runs.controller.ts, runs/runs.module.ts
  worker/agent-step.ts          AgentStep port + StubAgentStep
  worker/errors.ts              PermanentError, classifyError, backoffSeconds
  worker/worker.service.ts      processNextRun()
  worker/worker.loop.ts         interval tick orchestration
  worker/worker.module.ts
  approvals/subject-token.ts, approvals/approval.repository.ts
  actions/action.repository.ts
  agent/llm-client.ts, agent/anthropic-llm-client.ts, agent/tools.ts, agent/prompts.ts
  agent/agent-runner.ts, agent/agent.module.ts
  mail/format.ts, mail/templates.ts
  mail/mail-provider.ts, mail/agentmail.provider.ts, mail/outbox.service.ts, mail/mail.module.ts
  inbound/inbound-event.repository.ts, inbound/correlation.ts
  inbound/reply-classifier.ts, inbound/claude-reply-classifier.ts
  inbound/webhook.controller.ts, inbound/inbound.processor.ts, inbound/inbound.module.ts
  expiry/expiry.service.ts, expiry/expiry.module.ts
test/
  global-setup.ts, global-teardown.ts
  helpers/db.ts, helpers/config.ts, helpers/app.ts, helpers/fixtures.ts, helpers/harness.ts
  fakes/scripted-llm.ts, fakes/fake-mail.ts, fakes/fake-classifier.ts
  **/*.int-spec.ts, **/*.concurrency.int-spec.ts
```

---

# Phase C — Contract (design-first, D004)

### Task 1: Project scaffold and OpenAPI contract

**Files:**
- Create: the project scaffold (via Nest CLI), `jest.config.js`, `tsconfig.build.json`, `docs/api/openapi.yaml`
- Delete: sample `src/app.controller.ts`, `src/app.service.ts`, `src/app.controller.spec.ts`, `test/app.e2e-spec.ts`, `test/jest-e2e.json`
- Modify: `package.json` scripts, `src/app.module.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - npm scripts `test`, `test:int`, `test:stress`, `typecheck`, `lint`, `render:mocks`, `build`;
  - `docs/api/openapi.yaml`, the canonical contract for `POST /runs`, `GET /runs/{id}`, `POST /webhooks/mail`, `GET /health`.

- [ ] **Step 1: Generate the Nest scaffold into scratch and copy it in**

The project root already has `docs/`, `CLAUDE.md` and `.claude/`. Do not overwrite them.

```bash
cd /tmp && rm -rf mailgate-scaffold && npx -y @nestjs/cli@11 new mailgate-scaffold --package-manager npm --skip-git --skip-install --strict
rsync -a --exclude README.md /tmp/mailgate-scaffold/ /Users/roberto/Documents/mailgate/
cd /Users/roberto/Documents/mailgate && rm -f src/app.controller.ts src/app.service.ts src/app.controller.spec.ts test/app.e2e-spec.ts test/jest-e2e.json
npm install
```

- [ ] **Step 2: Reduce `src/app.module.ts` to an empty module**

```ts
import { Module } from '@nestjs/common';

@Module({ imports: [] })
export class AppModule {}
```

- [ ] **Step 3: Replace the Jest config and scripts**

Remove the `"jest"` block from `package.json`. Create `jest.config.js`:

```js
/** Unit tests: pure code under src/. */
module.exports = {
  rootDir: '.',
  testRegex: 'src/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Prisma 7 generated client imports "./x.js"; map to the .ts sources (RESEARCH Q3, nestjs#16051)
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
};
```

In `package.json`, set `"scripts"` (keep `build`, `start`, `start:dev`, `start:prod`, `format` from the scaffold):

```json
"test": "jest -c jest.config.js",
"test:int": "jest -c jest.int.config.js --runInBand",
"test:stress": "bash scripts/stress.sh",
"typecheck": "tsc --noEmit -p tsconfig.json",
"lint": "eslint \"{src,test,scripts}/**/*.ts\"",
"render:mocks": "ts-node scripts/render-mocks.ts"
```

Create `tsconfig.build.json` so that `dist/main.js` is the entry point:

```json
{ "extends": "./tsconfig.json", "include": ["src/**/*"], "exclude": ["node_modules", "dist", "**/*.spec.ts"] }
```

- [ ] **Step 4: Write `docs/api/openapi.yaml`**

```yaml
openapi: 3.1.0
info:
  title: mailgate
  version: 0.1.0
  description: Durable human-in-the-loop for AI agents via e-mail. Reimbursement demo.
  license: { name: MIT, identifier: MIT }
servers:
  - url: http://localhost:3000
paths:
  /health:
    get:
      operationId: health
      summary: Liveness plus database check
      responses:
        '200': { description: OK, content: { application/json: { schema: { type: object, required: [status], properties: { status: { const: ok } } } } } }
        '503': { description: Database unavailable }
  /runs:
    post:
      operationId: createRun
      summary: Create a reimbursement run (starts PENDING)
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: '#/components/schemas/ReimbursementInput' } } }
      responses:
        '201':
          description: Created
          content: { application/json: { schema: { type: object, required: [id, status], properties: { id: { type: string, format: uuid }, status: { const: PENDING } } } } }
        '400': { description: Validation error, content: { application/json: { schema: { $ref: '#/components/schemas/ValidationError' } } } }
  /runs/{id}:
    get:
      operationId: getRun
      summary: Run status, approval, action and timeline
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200': { description: OK, content: { application/json: { schema: { $ref: '#/components/schemas/RunView' } } } }
        '400': { description: Id is not a UUID }
        '404': { description: Not found }
  /webhooks/mail:
    post:
      operationId: mailWebhook
      summary: AgentMail webhook (Svix-signed). Stores message.received events; never decides inline.
      parameters:
        - { name: svix-id, in: header, required: true, schema: { type: string } }
        - { name: svix-timestamp, in: header, required: true, schema: { type: string } }
        - { name: svix-signature, in: header, required: true, schema: { type: string } }
      requestBody:
        required: true
        content: { application/json: { schema: { type: object } } }
      responses:
        '200':
          description: Accepted (also for duplicates and ignored event types)
          content: { application/json: { schema: { type: object, required: [received, stored], properties: { received: { const: true }, stored: { type: boolean } } } } }
        '401': { description: Invalid or missing signature; nothing stored }
components:
  schemas:
    Category: { type: string, enum: [TRAVEL, MEALS, EQUIPMENT, TRAINING, OTHER] }
    ReimbursementInput:
      type: object
      additionalProperties: false
      required: [description, amountCents, category, requesterEmail, approverEmail]
      properties:
        description: { type: string, minLength: 1, maxLength: 2000 }
        amountCents: { type: integer, minimum: 1, maximum: 100000000, description: 'BRL cents; 50000 = R$ 500,00' }
        category: { $ref: '#/components/schemas/Category' }
        requesterEmail: { type: string, format: email }
        approverEmail: { type: string, format: email }
      example: { description: Hotel em SP para visita a cliente, amountCents: 84000, category: TRAVEL, requesterEmail: ana@acme.test, approverEmail: gestor@acme.test }
    RunStatus: { type: string, enum: [PENDING, RUNNING, WAITING_APPROVAL, COMPLETED, FAILED, EXPIRED] }
    RunView:
      type: object
      required: [id, status, input, attempts, lastError, approval, action, timeline]
      properties:
        id: { type: string, format: uuid }
        status: { $ref: '#/components/schemas/RunStatus' }
        input: { $ref: '#/components/schemas/ReimbursementInput' }
        attempts: { type: integer }
        lastError: { type: [string, 'null'] }
        approval:
          oneOf:
            - type: 'null'
            - type: object
              required: [status, decision, note, expiresAt]
              properties:
                status: { type: string, enum: [CREATED, SENT, DECIDED, EXPIRED] }
                decision: { type: [string, 'null'], enum: [APPROVED, REJECTED, null] }
                note: { type: [string, 'null'] }
                expiresAt: { type: string, format: date-time }
        action:
          oneOf:
            - type: 'null'
            - type: object
              required: [type, payload, createdAt]
              properties:
                type: { type: string, enum: [REIMBURSEMENT_APPROVED, REIMBURSEMENT_REJECTED] }
                payload: { type: object }
                createdAt: { type: string, format: date-time }
        timeline:
          type: array
          items:
            type: object
            required: [at, type, data]
            properties: { at: { type: string, format: date-time }, type: { type: string }, data: { type: object } }
    ValidationError:
      type: object
      required: [message, errors]
      properties:
        message: { type: string }
        errors: { type: array, items: { type: object, required: [path, message], properties: { path: { type: string }, message: { type: string } } } }
```

- [ ] **Step 5: Lint the contract, then verify build and typecheck**

Run: `npx -y @redocly/cli@latest lint docs/api/openapi.yaml`
Expected: `Woohoo! Your API description is valid.` Warnings are acceptable; errors are not.

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 6: Checkpoint.** Report the files created and ask the user whether to commit.

---

### Task 2: E-mail templates, input schema and visual mocks (visual approval gate)

**Files:**
- Create: `src/runs/reimbursement-input.ts`, `src/mail/format.ts`, `src/mail/templates.ts`, `scripts/render-mocks.ts`
- Test: `src/runs/reimbursement-input.spec.ts`, `src/mail/format.spec.ts`, `src/mail/templates.spec.ts`
- Generate: `docs/mocks/approval.html`, `docs/mocks/approval.txt`, `docs/mocks/clarification.txt`, `docs/mocks/clarification.html`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `reimbursementInputSchema`, `ReimbursementInput`, `Category`, `CATEGORIES`, `CATEGORY_LABEL`;
  - `formatBRL(cents: number): string`, `formatDeadline(d: Date): string`;
  - `renderApprovalEmail(d: ApprovalEmailData): RenderedEmail`, `renderClarificationEmail(): { text: string; html: string }`;
  - `SUBJECT_TOKEN_RE: RegExp`, `ApprovalEmailData`, `RenderedEmail`.

- [ ] **Step 1: Install zod**

Run: `npm i -E zod`

- [ ] **Step 2: Write the failing tests**

`src/runs/reimbursement-input.spec.ts`:

```ts
import { reimbursementInputSchema } from './reimbursement-input';

const valid = {
  description: 'Hotel em SP para visita a cliente',
  amountCents: 84000,
  category: 'TRAVEL',
  requesterEmail: 'Ana@Acme.test',
  approverEmail: ' GESTOR@acme.test ',
};

describe('reimbursementInputSchema', () => {
  it('accepts a valid input and normalizes e-mails', () => {
    const r = reimbursementInputSchema.parse(valid);
    expect(r.requesterEmail).toBe('ana@acme.test');
    expect(r.approverEmail).toBe('gestor@acme.test');
  });
  it.each([
    ['float amount', { amountCents: 840.5 }],
    ['string amount', { amountCents: '84000' }],
    ['zero amount', { amountCents: 0 }],
    ['too large', { amountCents: 100_000_001 }],
    ['bad category', { category: 'FUN' }],
    ['bad email', { approverEmail: 'not-an-email' }],
    ['empty description', { description: '   ' }],
    ['extra field', { extra: 1 }],
  ])('rejects %s', (_label, patch) => {
    expect(reimbursementInputSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
```

`src/mail/format.spec.ts`:

```ts
import { formatBRL, formatDeadline } from './format';

describe('format', () => {
  it('formats cents as BRL with a plain space', () => {
    expect(formatBRL(84000)).toBe('R$ 840,00');
    expect(formatBRL(123456789)).toBe('R$ 1.234.567,89');
  });
  it('formats deadlines in America/Sao_Paulo', () => {
    const s = formatDeadline(new Date('2026-09-25T17:30:00Z'));
    expect(s).toContain('25/09/2026');
    expect(s).toContain('14:30');
  });
});
```

`src/mail/templates.spec.ts`:

```ts
import { renderApprovalEmail, renderClarificationEmail, SUBJECT_TOKEN_RE } from './templates';

const data = {
  subjectToken: 'abcd2345',
  description: 'Hotel <b>SP</b>',
  category: 'TRAVEL' as const,
  amountCents: 84000,
  requesterEmail: 'ana@acme.test',
  summary: 'Duas diárias de hotel para visita a cliente.',
  recommendation: 'APPROVE' as const,
  rationale: 'Valor compatível com a política de viagem.',
  expiresAt: new Date('2026-09-25T17:30:00Z'),
};

describe('renderApprovalEmail', () => {
  const e = renderApprovalEmail(data);
  it('builds the subject with token and amount', () => {
    expect(e.subject).toBe('[mailgate #abcd2345] Reembolso de R$ 840,00 — aprovação necessária');
    expect(SUBJECT_TOKEN_RE.exec(e.subject)?.[1]).toBe('abcd2345');
  });
  it('includes every required field in the text body', () => {
    for (const s of ['Hotel <b>SP</b>', 'Viagem', 'R$ 840,00', 'ana@acme.test', data.summary, 'APROVAR', data.rationale,
      'Responda este e-mail com APROVO ou RECUSO (pode incluir um comentário).', '25/09/2026']) {
      expect(e.text).toContain(s);
    }
  });
  it('escapes user content in HTML', () => {
    expect(e.html).toContain('Hotel &lt;b&gt;SP&lt;/b&gt;');
    expect(e.html).not.toContain('<b>SP</b>');
  });
  it('renders REJECT as RECUSAR', () => {
    expect(renderApprovalEmail({ ...data, recommendation: 'REJECT' }).text).toContain('Recomendação do agente: RECUSAR');
  });
});

describe('renderClarificationEmail', () => {
  it('asks for APROVO or RECUSO only', () => {
    expect(renderClarificationEmail().text).toContain('Não consegui entender sua resposta. Responda apenas APROVO ou RECUSO.');
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npm test`
Expected: FAIL, with "Cannot find module './reimbursement-input'" (and the same for the other two).

- [ ] **Step 4: Implement**

`src/runs/reimbursement-input.ts`:

```ts
import { z } from 'zod';

export const CATEGORIES = ['TRAVEL', 'MEALS', 'EQUIPMENT', 'TRAINING', 'OTHER'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  TRAVEL: 'Viagem',
  MEALS: 'Alimentação',
  EQUIPMENT: 'Equipamento',
  TRAINING: 'Treinamento',
  OTHER: 'Outros',
};

const email = z.string().trim().toLowerCase().email();

export const reimbursementInputSchema = z
  .object({
    description: z.string().trim().min(1).max(2000),
    amountCents: z.number().int().min(1).max(100_000_000),
    category: z.enum(CATEGORIES),
    requesterEmail: email,
    approverEmail: email,
  })
  .strict();

export type ReimbursementInput = z.infer<typeof reimbursementInputSchema>;
```

`src/mail/format.ts`:

```ts
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const deadline = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});

/** 84000 -> "R$ 840,00" (Intl uses NBSP; e-mails get a plain space). */
export function formatBRL(cents: number): string {
  return brl.format(cents / 100).replace(/ /g, ' ');
}

export function formatDeadline(d: Date): string {
  return deadline.format(d).replace(/ /g, ' ');
}
```

`src/mail/templates.ts`:

```ts
import { CATEGORY_LABEL, Category } from '../runs/reimbursement-input';
import { formatBRL, formatDeadline } from './format';

export const SUBJECT_TOKEN_RE = /\[mailgate #([a-z2-7]{8})\]/i;

export interface ApprovalEmailData {
  subjectToken: string;
  description: string;
  category: Category;
  amountCents: number;
  requesterEmail: string;
  summary: string;
  recommendation: 'APPROVE' | 'REJECT';
  rationale: string;
  expiresAt: Date;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const INSTRUCTION = 'Responda este e-mail com APROVO ou RECUSO (pode incluir um comentário).';
const CLARIFICATION = 'Não consegui entender sua resposta. Responda apenas APROVO ou RECUSO.';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderApprovalEmail(d: ApprovalEmailData): RenderedEmail {
  const amount = formatBRL(d.amountCents);
  const rec = d.recommendation === 'APPROVE' ? 'APROVAR' : 'RECUSAR';
  const due = formatDeadline(d.expiresAt);
  const subject = `[mailgate #${d.subjectToken}] Reembolso de ${amount} — aprovação necessária`;

  const text = [
    'Olá,',
    '',
    'Um pedido de reembolso precisa da sua aprovação.',
    '',
    `Descrição: ${d.description}`,
    `Categoria: ${CATEGORY_LABEL[d.category]}`,
    `Valor: ${amount}`,
    `Solicitante: ${d.requesterEmail}`,
    '',
    'Resumo do agente:',
    d.summary,
    '',
    `Recomendação do agente: ${rec}`,
    `Justificativa: ${d.rationale}`,
    '',
    INSTRUCTION,
    `Prazo para resposta: ${due} (horário de Brasília). Sem resposta até lá, o pedido expira.`,
    '',
    '— mailgate',
  ].join('\n');

  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555">${k}</td><td style="padding:4px 0"><strong>${escapeHtml(v)}</strong></td></tr>`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:560px">
<p>Olá,</p>
<p>Um pedido de reembolso precisa da sua aprovação.</p>
<table style="border-collapse:collapse">${row('Descrição', d.description)}${row('Categoria', CATEGORY_LABEL[d.category])}${row('Valor', amount)}${row('Solicitante', d.requesterEmail)}</table>
<p style="margin-top:16px"><strong>Resumo do agente</strong><br>${escapeHtml(d.summary)}</p>
<p><strong>Recomendação do agente: ${rec}</strong><br>${escapeHtml(d.rationale)}</p>
<p style="padding:12px;background:#f3f4f6;border-radius:6px"><strong>${INSTRUCTION}</strong></p>
<p style="color:#555">Prazo para resposta: ${escapeHtml(due)} (horário de Brasília). Sem resposta até lá, o pedido expira.</p>
<p style="color:#888">— mailgate</p>
</div>`;

  return { subject, text, html };
}

export function renderClarificationEmail(): { text: string; html: string } {
  return {
    text: `${CLARIFICATION}\n\n— mailgate`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px"><p><strong>${CLARIFICATION}</strong></p><p style="color:#888">— mailgate</p></div>`,
  };
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npm test`
Expected: PASS (3 suites).

- [ ] **Step 6: Write `scripts/render-mocks.ts` and render the mocks**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderApprovalEmail, renderClarificationEmail } from '../src/mail/templates';

const out = join(__dirname, '..', 'docs', 'mocks');
mkdirSync(out, { recursive: true });

const approval = renderApprovalEmail({
  subjectToken: 'k7q2m4xa',
  description: 'Hotel em São Paulo (2 diárias) para visita ao cliente Beta',
  category: 'TRAVEL',
  amountCents: 84000,
  requesterEmail: 'ana@acme.test',
  summary: 'Duas diárias de hotel em SP para reunião presencial com o cliente Beta, com nota fiscal anexada.',
  recommendation: 'APPROVE',
  rationale: 'Valor dentro da média de hospedagem para a cidade e viagem justificada por reunião de contrato.',
  expiresAt: new Date('2026-09-25T17:30:00Z'),
});
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="background:#e5e7eb;padding:24px"><div style="background:#fff;padding:24px;max-width:600px;margin:auto"><p style="color:#666;font:13px monospace">Assunto: ${title}</p>${body}</div></body>`;

writeFileSync(join(out, 'approval.txt'), `Assunto: ${approval.subject}\n\n${approval.text}\n`);
writeFileSync(join(out, 'approval.html'), page(approval.subject, approval.html));
const clar = renderClarificationEmail();
writeFileSync(join(out, 'clarification.txt'), `${clar.text}\n`);
writeFileSync(join(out, 'clarification.html'), page('Re: [mailgate #k7q2m4xa] …', clar.html));
console.log(`mocks written to ${out}`);
```

Run: `npm run render:mocks`
Expected: `mocks written to .../docs/mocks`, and four files exist.

- [ ] **Step 7: STOP. Ask for visual approval**

1. Open `docs/mocks/approval.html` and `docs/mocks/clarification.html` in the browser pane.
2. Show `docs/mocks/approval.txt` and `docs/api/openapi.yaml` to the user.
3. Ask for **explicit visual approval** of the e-mails and the API contract. On change requests, edit `templates.ts`, re-render and ask again.
4. Do not start Task 3 before approval. This window's "done" criterion includes approval, and specs 0001–0004 in `docs/01-specs` go to `approved` at close-window.

- [ ] **Step 8: Checkpoint.** Ask the user whether to commit.

---

# Phase F0 — Foundation

### Task 3: Config, Prisma 7, `runs` migration, health endpoint and Testcontainers harness

**Files:**
- Create: `src/config/config.ts`, `src/config/config.module.ts`, `src/prisma/prisma.service.ts`, `src/prisma/database.module.ts`, `src/prisma/db.ts`, `src/health/health.controller.ts`, `src/health/health.module.ts`, `prisma.config.ts`, `prisma/schema.prisma`, `docker-compose.yml` (postgres only for now), `.env.example`, `.env` (local, not committed), `jest.int.config.js`, `test/global-setup.ts`, `test/global-teardown.ts`, `test/helpers/db.ts`, `test/helpers/config.ts`, `test/helpers/app.ts`
- Modify: `src/main.ts`, `src/app.module.ts`, `.gitignore` (add `src/generated/`, `.env`)
- Test: `src/config/config.spec.ts`, `test/health/health.int-spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AppConfig`, `APP_CONFIG`, `loadConfig(env?)`;
  - `PrismaService extends PrismaClient`, `Db = PrismaClient | Prisma.TransactionClient`;
  - `DatabaseModule` (global; later tasks add repositories to it);
  - test helpers `newPrisma(max?)`, `truncateAll(prisma)`, `testConfig(overrides?)`, `createTestApp(configure?)`.
  - Import path of the client: `src/generated/prisma/client`.

- [ ] **Step 1: Install dependencies**

```bash
npm i -E prisma@7 @prisma/client@7 @prisma/adapter-pg@7 pg dotenv @anthropic-ai/sdk
npm i -D -E @types/pg @testcontainers/postgresql supertest @types/supertest
```

`prisma` stays in `dependencies`, not devDependencies, because the Docker `migrate` service runs it from the production image (RESEARCH Q3, prisma#28983).

- [ ] **Step 2: Write the failing config unit test**

`src/config/config.spec.ts`:

```ts
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://u:p@h:5432/d' });
    expect(c).toMatchObject({
      PORT: 3000, DB_POOL_MAX: 10, WORKER_ENABLED: true, WORKER_POLL_MS: 1000, LEASE_SECONDS: 120,
      MAX_ATTEMPTS: 5, MAX_TURNS: 10, AUTO_APPROVE_LIMIT_CENTS: 50000, APPROVAL_TTL_HOURS: 48,
      EXPIRY_INTERVAL_MS: 60000, OUTBOX_BATCH: 10, ANTHROPIC_MODEL: 'claude-opus-5', ANTHROPIC_FALLBACK: 'default',
    });
  });
  it('parses WORKER_ENABLED=false', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://x', WORKER_ENABLED: 'false' }).WORKER_ENABLED).toBe(false);
  });
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow();
  });
});
```

Run: `npm test -- config`
Expected: FAIL with "Cannot find module './config'".

- [ ] **Step 3: Implement config**

`src/config/config.ts`:

```ts
import { z } from 'zod';


const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  WORKER_ENABLED: z.string().optional().transform((v) => v !== 'false'),
  WORKER_POLL_MS: z.coerce.number().int().min(10).default(1000),
  LEASE_SECONDS: z.coerce.number().int().min(1).default(120),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  MAX_TURNS: z.coerce.number().int().min(1).default(10),
  AUTO_APPROVE_LIMIT_CENTS: z.coerce.number().int().min(0).default(50000),
  APPROVAL_TTL_HOURS: z.coerce.number().int().min(1).default(48),
  EXPIRY_INTERVAL_MS: z.coerce.number().int().min(10).default(60000),
  OUTBOX_BATCH: z.coerce.number().int().min(1).default(10),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_FALLBACK: z.enum(['default', 'off']).default('default'),
  AGENTMAIL_API_KEY: z.string().optional(),
  AGENTMAIL_INBOX_ID: z.string().optional(),
  AGENTMAIL_WEBHOOK_SECRET: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return schema.parse(env);
}
```

`src/config/config.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './config';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
```

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 4: Prisma config, schema, local Postgres**

`prisma.config.ts`. Use `process.env`, not `env()`, which throws when the variable is unset (RESEARCH Q3):

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
```

`prisma/schema.prisma`:

```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}

model Run {
  id         String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  status     String
  input      Json
  messages   Json      @default("[]")
  attempts   Int       @default(0)
  leaseToken String?   @map("lease_token") @db.Uuid
  leaseUntil DateTime? @map("lease_until") @db.Timestamptz(3)
  lastError  String?   @map("last_error")
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt  DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("runs")
}
```

`docker-compose.yml` (postgres only; Task 4 adds `migrate` and `api`):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: mailgate
      POSTGRES_PASSWORD: mailgate
      POSTGRES_DB: mailgate
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mailgate -d mailgate"]
      interval: 2s
      timeout: 3s
      retries: 30
    volumes: [pgdata:/var/lib/postgresql/data]
volumes:
  pgdata: {}
```

`.env.example` (copy it to `.env`):

```
DATABASE_URL=postgresql://mailgate:mailgate@localhost:5432/mailgate
PORT=3000
WORKER_ENABLED=true
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-5
AGENTMAIL_API_KEY=
AGENTMAIL_INBOX_ID=
AGENTMAIL_WEBHOOK_SECRET=
```

Append to `.gitignore`: `src/generated/` and `.env`.

Run: `cp .env.example .env && docker compose up -d postgres`
Expected: the `postgres` container becomes healthy (`docker compose ps` shows `healthy`).

- [ ] **Step 5: Create the migration with CHECK and a partial index**

Run: `npx prisma migrate dev --create-only --name init_runs`
Expected: `prisma/migrations/<ts>_init_runs/migration.sql` is created.

Append to that `migration.sql`:

```sql
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check"
  CHECK (status IN ('PENDING','RUNNING','WAITING_APPROVAL','COMPLETED','FAILED','EXPIRED'));
CREATE INDEX "runs_claimable_idx" ON "runs" ("created_at") WHERE status IN ('PENDING','RUNNING');
```

Run: `npx prisma migrate dev && npx prisma generate`
Expected: "Your database is now in sync with your schema", and `src/generated/prisma/client.ts` exists.

- [ ] **Step 6: PrismaService, Db type, DatabaseModule**

`src/prisma/prisma.service.ts`:

```ts
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { APP_CONFIG, AppConfig } from '../config/config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    // explicit pool: connectionTimeoutMillis defaults to 0 (wait forever) in pg (RESEARCH Q3)
    super({
      adapter: new PrismaPg({ connectionString: cfg.DATABASE_URL, max: cfg.DB_POOL_MAX, connectionTimeoutMillis: 5000 }),
    });
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

`src/prisma/db.ts`:

```ts
import { Prisma, PrismaClient } from '../generated/prisma/client';

/** Either the root client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;
```

`src/prisma/database.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class DatabaseModule {}
```

- [ ] **Step 7: Health endpoint, main.ts, AppModule**

`src/health/health.controller.ts`:

```ts
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }
}
```

`src/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './prisma/database.module';
import { HealthModule } from './health/health.module';

@Module({ imports: [ConfigModule, DatabaseModule, HealthModule] })
export class AppModule {}
```

`src/main.ts`:

```ts
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/config';

async function bootstrap(): Promise<void> {
  // rawBody is required for Svix signature verification on /webhooks/mail
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  const cfg = app.get<AppConfig>(APP_CONFIG);
  await app.listen(cfg.PORT);
}
void bootstrap();
```

- [ ] **Step 8: Testcontainers harness**

`jest.int.config.js`:

```js
/** Integration tests against a real Postgres 16 (Testcontainers). Always --runInBand. */
module.exports = {
  rootDir: '.',
  testRegex: 'test/.*\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  testTimeout: 60000,
};
```

`test/global-setup.ts`:

```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  execSync('npx prisma migrate deploy', { env: process.env, stdio: 'inherit' });
  (globalThis as { __PG__?: StartedPostgreSqlContainer }).__PG__ = container;
}
```

`test/global-teardown.ts`:

```ts
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export default async function globalTeardown(): Promise<void> {
  await (globalThis as { __PG__?: StartedPostgreSqlContainer }).__PG__?.stop();
}
```

`test/helpers/db.ts`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

export function newPrisma(max = 5): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max, connectionTimeoutMillis: 5000 }),
  });
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}
```

`test/helpers/config.ts`:

```ts
import { AppConfig, loadConfig } from '../../src/config/config';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...process.env, WORKER_ENABLED: 'false', ...overrides });
}
```

`test/helpers/app.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

export async function createTestApp(
  configure: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<INestApplication> {
  process.env.WORKER_ENABLED = 'false';
  const moduleRef = await configure(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  return app;
}
```

- [ ] **Step 9: Write the failing health integration test**

`test/health/health.int-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/app';

describe('GET /health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns 200 {status: ok} when the database is reachable', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });
});
```

Run: `npm run test:int`
Expected: PASS. The container starts, migrations are applied and the health check returns 200. If it fails with a module-resolution error from `src/generated/prisma`, confirm that `moduleNameMapper` is present and that `moduleFormat = "cjs"` is set, then re-run `npx prisma generate`.

- [ ] **Step 10: Verify the whole suite and the typecheck**

Run: `npm test && npm run test:int && npm run typecheck`
Expected: all green, exit 0.

- [ ] **Step 11: Checkpoint.** Ask the user whether to commit.

---

### Task 4: Docker image and full Compose (`postgres` → `migrate` → `api`)

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: the Task 3 build (`dist/main.js`) and the `prisma/` migrations.
- Produces: `docker compose up` brings the API up at `localhost:3000`, and `/health` returns 200.

- [ ] **Step 1: Write `Dockerfile`**

```Dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY prisma.config.ts ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

`.dockerignore`:

```
node_modules
dist
.env
.git
.claude
docs
src/generated
```

- [ ] **Step 2: Add `migrate` and `api` to `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: mailgate
      POSTGRES_PASSWORD: mailgate
      POSTGRES_DB: mailgate
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mailgate -d mailgate"]
      interval: 2s
      timeout: 3s
      retries: 30
    volumes: [pgdata:/var/lib/postgresql/data]
  migrate:
    build: .
    command: ["npx", "prisma", "migrate", "deploy"]
    environment:
      DATABASE_URL: postgresql://mailgate:mailgate@postgres:5432/mailgate
    depends_on:
      postgres: { condition: service_healthy }
  api:
    build: .
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: postgresql://mailgate:mailgate@postgres:5432/mailgate
      PORT: "3000"
    ports: ["3000:3000"]
    depends_on:
      migrate: { condition: service_completed_successfully }
volumes:
  pgdata: {}
```

- [ ] **Step 3: Verify from a clean state**

Run: `docker compose down -v && docker compose up -d --build && sleep 5 && curl -s -o /dev/stdout -w '\n%{http_code}\n' localhost:3000/health`
Expected: `{"status":"ok"}` followed by `200`. If `migrate` fails with "datasource.url property is required", check that `prisma.config.ts` was copied and that `dotenv` is in `dependencies`.

Run: `docker compose down`

- [ ] **Step 4: Checkpoint.** Ask the user whether to commit.

---

### Task 5: Lint/typecheck scripts, CI workflow, README skeleton, git (authorization gate)

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`
- Modify: `eslint.config.mjs` (ignore `src/generated/**`)

**Interfaces:**
- Consumes: the npm scripts from Task 1.
- Produces: CI running lint, typecheck, unit and integration tests on every push and PR.

- [ ] **Step 1: Make lint ignore generated code**

In `eslint.config.mjs`, add `'src/generated/**'` and `'dist/**'` to the `ignores` array of the first config object.

Run: `npm run lint && npm run typecheck`
Expected: exit 0. Fix every reported issue in hand-written files. Do not disable rules globally.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgresql://unused:unused@localhost:5432/unused
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:int
```

`test:int` overrides `DATABASE_URL` from the Testcontainers global setup. The job-level value only satisfies `loadConfig` and `prisma generate`.

- [ ] **Step 3: Write the `README.md` skeleton**

````markdown
# mailgate

Durable human-in-the-loop for AI agents via e-mail: the agent pauses at a decision point, e-mails an approver, and resumes only when the reply arrives — even hours later, even after a restart.

## Quickstart

```bash
cp .env.example .env        # fill ANTHROPIC_API_KEY and AGENTMAIL_* for the real flow
docker compose up --build
curl localhost:3000/health  # {"status":"ok"}
```

## Development

```bash
npm ci && npx prisma generate
npm test            # unit
npm run test:int    # integration (needs Docker)
npm run test:stress # concurrency suite 20x
```

Design: `docs/superpowers/specs/mailgate/design.md` · API: `docs/api/openapi.yaml`
````

- [ ] **Step 4: STOP. Git authorization gate**

Ask the user: "May I run `git init` here and create the GitHub repository (`gh repo create`) so CI can run?"
- If authorized, run `git init`. Then check that sdd artifacts are ignored: `git check-ignore -q .claude/sdd/ACTIVE && echo ignored || echo TRACKED`. If `TRACKED`, stop and tell the user. **Do not edit `.gitignore` for `.claude/`** (sdd rule).
- Pushing and opening the first CI run happen only when the user asks.

- [ ] **Step 5: Checkpoint.** Report that F0 acceptance is met locally (compose → health 200; lint, typecheck and tests green). Ask the user whether to commit and push. CI green is confirmed after their push.

---

# Phase F1 — Runs and leased worker

### Task 6: `POST /runs`, `GET /runs/:id`, `run_events`

**Files:**
- Create: `src/runs/run.ts`, `src/runs/run-events.ts`, `src/runs/run.repository.ts`, `src/runs/runs.service.ts`, `src/runs/runs.controller.ts`, `src/runs/runs.module.ts`, `test/helpers/fixtures.ts`
- Modify: `prisma/schema.prisma` (add `RunEvent`, `Run.events`), `src/prisma/database.module.ts` (add `RunRepository`), `src/app.module.ts` (add `RunsModule`)
- Test: `test/runs/runs-api.int-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `Db`, `reimbursementInputSchema`, `ReimbursementInput`.
- Produces:
  - `RunStatus`, `Run`, `Lease { runId: string; token: string }`, `LeaseLostError`, `RunRow`, `rowToRun(row)`, `modelToRun(model)`;
  - `RunEventType`, `appendRunEvent(db: Db, runId: string, type: RunEventType, data?: Record<string, unknown>): Promise<void>`;
  - `RunRepository.create(input): Promise<Run>`, `RunRepository.findById(id): Promise<Run | null>`;
  - `RunsService.getView(id): Promise<RunView | null>`;
  - `validInput(patch?)` fixture.

- [ ] **Step 1: Add `RunEvent` to the schema and migrate**

In `prisma/schema.prisma`, add `events RunEvent[]` to `model Run`, then append:

```prisma
model RunEvent {
  id    BigInt   @id @default(autoincrement())
  runId String   @map("run_id") @db.Uuid
  at    DateTime @default(now()) @db.Timestamptz(3)
  type  String
  data  Json     @default("{}")
  run   Run      @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId, at])
  @@map("run_events")
}
```

Run: `npx prisma migrate dev --name run_events && npx prisma generate`
Expected: migration created and applied.

- [ ] **Step 2: Write the fixtures and the failing API tests**

`test/helpers/fixtures.ts`:

```ts
import { ReimbursementInput } from '../../src/runs/reimbursement-input';

export function validInput(patch: Partial<ReimbursementInput> = {}): ReimbursementInput {
  return {
    description: 'Hotel em SP para visita a cliente',
    amountCents: 84000,
    category: 'TRAVEL',
    requesterEmail: 'ana@acme.test',
    approverEmail: 'gestor@acme.test',
    ...patch,
  };
}
```

`test/runs/runs-api.int-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createTestApp } from '../helpers/app';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

describe('runs API', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = newPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(() => truncateAll(prisma));

  it('POST /runs creates a PENDING run with a CREATED event', async () => {
    const res = await request(app.getHttpServer()).post('/runs')
      .send({ ...validInput(), approverEmail: 'GESTOR@ACME.TEST' }).expect(201);
    expect(res.body).toEqual({ id: expect.any(String), status: 'PENDING' });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(run.status).toBe('PENDING');
    expect((run.input as { approverEmail: string }).approverEmail).toBe('gestor@acme.test');
    expect(await prisma.runEvent.count({ where: { runId: run.id, type: 'CREATED' } })).toBe(1);
  });

  it.each([
    ['float amount', { amountCents: 840.5 }],
    ['numeric string amount', { amountCents: '84000' }],
    ['missing approver', { approverEmail: undefined }],
    ['bad category', { category: 'FUN' }],
    ['extra field', { hack: true }],
  ])('POST /runs rejects %s with 400 and stores nothing', async (_l, patch) => {
    const res = await request(app.getHttpServer()).post('/runs').send({ ...validInput(), ...patch }).expect(400);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(await prisma.run.count()).toBe(0);
  });

  it('GET /runs/:id returns the view with an ordered timeline', async () => {
    const { body } = await request(app.getHttpServer()).post('/runs').send(validInput()).expect(201);
    const res = await request(app.getHttpServer()).get(`/runs/${body.id}`).expect(200);
    expect(res.body).toMatchObject({
      id: body.id, status: 'PENDING', attempts: 0, lastError: null, approval: null, action: null,
      input: validInput(),
    });
    expect(res.body.timeline.map((e: { type: string }) => e.type)).toEqual(['CREATED']);
  });

  it('GET /runs/:id returns 404 for an unknown id and 400 for a non-uuid', async () => {
    await request(app.getHttpServer()).get('/runs/7a0c7c9e-3f6f-4a8e-9a55-0b8a7b3f3c11').expect(404);
    await request(app.getHttpServer()).get('/runs/not-a-uuid').expect(400);
  });
});
```

Run: `npm run test:int -- runs-api`
Expected: FAIL, 404 on `POST /runs` because the route does not exist.

- [ ] **Step 3: Implement the run domain, events and repository**

`src/runs/run.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { Run as RunModel } from '../generated/prisma/client';
import { ReimbursementInput } from './reimbursement-input';

export type RunStatus = 'PENDING' | 'RUNNING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface Run {
  id: string;
  status: RunStatus;
  input: ReimbursementInput;
  messages: Anthropic.MessageParam[];
  attempts: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Lease {
  runId: string;
  token: string;
}

export class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`lease lost for run ${runId}`);
    this.name = 'LeaseLostError';
  }
}

/** Row shape returned by $queryRaw (snake_case, jsonb already parsed). */
export interface RunRow {
  id: string;
  status: string;
  input: unknown;
  messages: unknown;
  attempts: number;
  lease_token: string | null;
  lease_until: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function rowToRun(r: RunRow): Run {
  return {
    id: r.id,
    status: r.status as RunStatus,
    input: r.input as ReimbursementInput,
    messages: r.messages as Anthropic.MessageParam[],
    attempts: r.attempts,
    leaseToken: r.lease_token,
    leaseUntil: r.lease_until,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function modelToRun(m: RunModel): Run {
  return {
    ...m,
    status: m.status as RunStatus,
    input: m.input as unknown as ReimbursementInput,
    messages: m.messages as unknown as Anthropic.MessageParam[],
  };
}
```

`src/runs/run-events.ts`:

```ts
import { Prisma } from '../generated/prisma/client';
import { Db } from '../prisma/db';

export type RunEventType =
  | 'CREATED' | 'CLAIMED' | 'LEASE_LOST' | 'RETRY_SCHEDULED' | 'APPROVAL_REQUESTED' | 'APPROVAL_SENT'
  | 'DECISION_RECEIVED' | 'RESUMED' | 'ACTION_RECORDED' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export async function appendRunEvent(
  db: Db,
  runId: string,
  type: RunEventType,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.runEvent.create({ data: { runId, type, data: data as Prisma.InputJsonValue } });
}
```

`src/runs/run.repository.ts`, first part (Task 7 adds the lease methods):

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementInput } from './reimbursement-input';
import { appendRunEvent } from './run-events';
import { modelToRun, Run } from './run';

@Injectable()
export class RunRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  async create(input: ReimbursementInput): Promise<Run> {
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.run.create({
        data: { status: 'PENDING', input: input as unknown as Prisma.InputJsonValue },
      });
      await appendRunEvent(tx, m.id, 'CREATED');
      return modelToRun(m);
    });
  }

  async findById(id: string): Promise<Run | null> {
    const m = await this.prisma.run.findUnique({ where: { id } });
    return m ? modelToRun(m) : null;
  }
}
```

Add `RunRepository` to `providers` and `exports` of `DatabaseModule`.

- [ ] **Step 4: Service, controller, module**

`src/runs/runs.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementInput } from './reimbursement-input';
import { Run } from './run';
import { RunRepository } from './run.repository';

export interface RunView {
  id: string;
  status: Run['status'];
  input: ReimbursementInput;
  attempts: number;
  lastError: string | null;
  approval: { status: string; decision: string | null; note: string | null; expiresAt: Date } | null;
  action: { type: string; payload: unknown; createdAt: Date } | null;
  timeline: { at: Date; type: string; data: unknown }[];
}

@Injectable()
export class RunsService {
  constructor(
    private readonly runs: RunRepository,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
  ) {}

  create(input: ReimbursementInput): Promise<Run> {
    return this.runs.create(input);
  }

  async getView(id: string): Promise<RunView | null> {
    const run = await this.runs.findById(id);
    if (!run) return null;
    const events = await this.prisma.runEvent.findMany({ where: { runId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    return {
      id: run.id,
      status: run.status,
      input: run.input,
      attempts: run.attempts,
      lastError: run.lastError,
      approval: null,
      action: null,
      timeline: events.map((e) => ({ at: e.at, type: e.type, data: e.data })),
    };
  }
}
```

`src/runs/runs.controller.ts`:

```ts
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { reimbursementInputSchema } from './reimbursement-input';
import { RunsService, RunView } from './runs.service';

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<{ id: string; status: 'PENDING' }> {
    const parsed = reimbursementInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'invalid input',
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const run = await this.runs.create(parsed.data);
    return { id: run.id, status: 'PENDING' };
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string): Promise<RunView> {
    const view = await this.runs.getView(id);
    if (!view) throw new NotFoundException();
    return view;
  }
}
```

`src/runs/runs.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({ controllers: [RunsController], providers: [RunsService], exports: [RunsService] })
export class RunsModule {}
```

Add `RunsModule` to the `imports` of `AppModule`.

- [ ] **Step 5: Run the tests**

Run: `npm run test:int -- runs-api`
Expected: PASS (all cases).

- [ ] **Step 6: Checkpoint.** Ask the user whether to commit.

---

### Task 7: Claim, lease and fenced transitions in `RunRepository`

**Files:**
- Modify: `src/runs/run.repository.ts`
- Test: `test/runs/run-lease.int-spec.ts`

**Interfaces:**
- Consumes: `Run`, `Lease`, `LeaseLostError`, `RunRow`, `rowToRun`, `appendRunEvent`, `Db`.
- Produces (all on `RunRepository`):
  - `claim(leaseSeconds: number): Promise<{ run: Run; lease: Lease; reclaimed: boolean } | null>`;
  - `saveMessages(lease: Lease, messages: Anthropic.MessageParam[], leaseSeconds: number): Promise<void>`, which throws `LeaseLostError`;
  - `complete(lease: Lease): Promise<void>`, which throws `LeaseLostError`;
  - `fail(lease: Lease, error: string): Promise<void>`, which throws `LeaseLostError`;
  - `scheduleRetry(lease: Lease, error: string, delaySeconds: number): Promise<void>`, which throws `LeaseLostError`.

- [ ] **Step 1: Write the failing tests**

`test/runs/run-lease.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { LeaseLostError } from '../../src/runs/run';
import { RunRepository } from '../../src/runs/run.repository';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

describe('RunRepository lease', () => {
  let prisma: PrismaClient;
  let repo: RunRepository;
  beforeAll(() => {
    prisma = newPrisma();
    repo = new RunRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('claims the oldest PENDING run with a fresh token', async () => {
    const a = await repo.create(validInput());
    await repo.create(validInput());
    const c = await repo.claim(60);
    expect(c?.run.id).toBe(a.id);
    expect(c?.run.status).toBe('RUNNING');
    expect(c?.run.attempts).toBe(1);
    expect(c?.lease.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(c?.reclaimed).toBe(false);
    expect(await prisma.runEvent.count({ where: { runId: a.id, type: 'CLAIMED' } })).toBe(1);
  });

  it('returns null when nothing is claimable', async () => {
    expect(await repo.claim(60)).toBeNull();
  });

  it('skips PENDING runs whose backoff (lease_until) is in the future', async () => {
    const r = await repo.create(validInput());
    await prisma.$executeRaw`UPDATE runs SET lease_until = now() + interval '1 hour' WHERE id = ${r.id}::uuid`;
    expect(await repo.claim(60)).toBeNull();
  });

  it('reclaims a RUNNING run whose lease expired, with a new token, and fences the old holder', async () => {
    await repo.create(validInput());
    const first = (await repo.claim(60))!;
    await prisma.$executeRaw`UPDATE runs SET lease_until = now() - interval '1 second' WHERE id = ${first.run.id}::uuid`;
    const second = (await repo.claim(60))!;
    expect(second.run.id).toBe(first.run.id);
    expect(second.reclaimed).toBe(true);
    expect(second.lease.token).not.toBe(first.lease.token);
    expect(second.run.attempts).toBe(2);
    expect(await prisma.runEvent.count({ where: { runId: first.run.id, type: 'LEASE_LOST' } })).toBe(1);

    // zombie writes with the old token are rejected and change nothing
    await expect(repo.saveMessages(first.lease, [{ role: 'user', content: 'zombie' }], 60)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(repo.complete(first.lease)).rejects.toBeInstanceOf(LeaseLostError);
    const row = await prisma.run.findUniqueOrThrow({ where: { id: first.run.id } });
    expect(row.messages).toEqual([]);
    expect(row.status).toBe('RUNNING');
  });

  it('saveMessages renews the lease', async () => {
    await repo.create(validInput());
    const c = (await repo.claim(1))!;
    await repo.saveMessages(c.lease, [{ role: 'user', content: 'hi' }], 300);
    const [{ secs }] = await prisma.$queryRaw<{ secs: number }[]>`
      SELECT EXTRACT(EPOCH FROM (lease_until - now()))::float8 AS secs FROM runs WHERE id = ${c.run.id}::uuid`;
    expect(secs).toBeGreaterThan(250);
  });

  it('complete / fail / scheduleRetry transition with events', async () => {
    await repo.create(validInput());
    await repo.create(validInput());
    await repo.create(validInput());
    const a = (await repo.claim(60))!;
    await repo.complete(a.lease);
    const b = (await repo.claim(60))!;
    await repo.fail(b.lease, 'boom');
    const c = (await repo.claim(60))!;
    await repo.scheduleRetry(c.lease, 'rate limited', 30);

    const [ra, rb, rc] = await Promise.all([a, b, c].map((x) => prisma.run.findUniqueOrThrow({ where: { id: x.run.id } })));
    expect(ra).toMatchObject({ status: 'COMPLETED', leaseToken: null, leaseUntil: null });
    expect(rb).toMatchObject({ status: 'FAILED', lastError: 'boom', leaseToken: null });
    expect(rc).toMatchObject({ status: 'PENDING', lastError: 'rate limited', leaseToken: null });
    expect(rc.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await prisma.runEvent.count({ where: { type: { in: ['COMPLETED', 'FAILED', 'RETRY_SCHEDULED'] } } })).toBe(3);
  });
});
```

Run: `npm run test:int -- run-lease`
Expected: FAIL with "repo.claim is not a function".

- [ ] **Step 2: Implement the lease methods**

Add to `RunRepository`. Keep the existing methods and add the imports `Anthropic` (type), `LeaseLostError`, `Lease`, `RunRow`, `rowToRun`.

```ts
  async claim(leaseSeconds: number): Promise<{ run: Run; lease: Lease; reclaimed: boolean } | null> {
    const rows = await this.prisma.$queryRaw<(RunRow & { prev_status: string })[]>`
      WITH picked AS (
        SELECT id, status AS prev_status FROM runs
        WHERE (status = 'PENDING' AND (lease_until IS NULL OR lease_until <= now()))
           OR (status = 'RUNNING' AND lease_until < now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      UPDATE runs r
         SET status = 'RUNNING', lease_token = gen_random_uuid(),
             lease_until = now() + make_interval(secs => ${leaseSeconds}::float8),
             attempts = r.attempts + 1, updated_at = now()
        FROM picked
       WHERE r.id = picked.id
      RETURNING r.*, picked.prev_status`;
    const row = rows[0];
    if (!row) return null;
    const run = rowToRun(row);
    const reclaimed = row.prev_status === 'RUNNING';
    if (reclaimed) await appendRunEvent(this.prisma, run.id, 'LEASE_LOST', { attempts: run.attempts });
    await appendRunEvent(this.prisma, run.id, 'CLAIMED', { attempts: run.attempts });
    return { run, lease: { runId: run.id, token: run.leaseToken! }, reclaimed };
  }

  async saveMessages(lease: Lease, messages: Anthropic.MessageParam[], leaseSeconds: number): Promise<void> {
    const n = await this.prisma.$executeRaw`
      UPDATE runs SET messages = ${JSON.stringify(messages)}::jsonb,
             lease_until = now() + make_interval(secs => ${leaseSeconds}::float8), updated_at = now()
       WHERE id = ${lease.runId}::uuid AND lease_token = ${lease.token}::uuid AND status = 'RUNNING'`;
    if (n === 0) throw new LeaseLostError(lease.runId);
  }

  async complete(lease: Lease): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.fenced(tx, lease, { status: 'COMPLETED', leaseToken: null, leaseUntil: null });
      await appendRunEvent(tx, lease.runId, 'COMPLETED');
    });
  }

  async fail(lease: Lease, error: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.fenced(tx, lease, { status: 'FAILED', leaseToken: null, leaseUntil: null, lastError: error });
      await appendRunEvent(tx, lease.runId, 'FAILED', { error });
    });
  }

  async scheduleRetry(lease: Lease, error: string, delaySeconds: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE runs SET status = 'PENDING', lease_token = NULL,
               lease_until = now() + make_interval(secs => ${delaySeconds}::float8),
               last_error = ${error}, updated_at = now()
         WHERE id = ${lease.runId}::uuid AND lease_token = ${lease.token}::uuid AND status = 'RUNNING'`;
      if (n === 0) throw new LeaseLostError(lease.runId);
      await appendRunEvent(tx, lease.runId, 'RETRY_SCHEDULED', { error, delaySeconds });
    });
  }

  /** Guarded write by the lease holder (convention 0001). */
  protected async fenced(db: Db, lease: Lease, data: Prisma.RunUpdateManyMutationInput): Promise<void> {
    const { count } = await db.run.updateMany({
      where: { id: lease.runId, leaseToken: lease.token, status: 'RUNNING' },
      data,
    });
    if (count === 0) throw new LeaseLostError(lease.runId);
  }
```

Import `Db` from `../prisma/db` and `type Anthropic from '@anthropic-ai/sdk'`.

- [ ] **Step 3: Run the tests**

Run: `npm run test:int -- run-lease`
Expected: PASS.

- [ ] **Step 4: Checkpoint.** Ask the user whether to commit.

---

### Task 8: Worker service, loop, error policy, I4 concurrency and stress script

**Files:**
- Create: `src/worker/agent-step.ts`, `src/worker/errors.ts`, `src/worker/worker.service.ts`, `src/worker/worker.loop.ts`, `src/worker/worker.module.ts`, `scripts/stress.sh`
- Modify: `src/app.module.ts` (add `WorkerModule`)
- Test: `src/worker/errors.spec.ts`, `test/worker/worker.int-spec.ts`, `test/worker/claim.concurrency.int-spec.ts`

**Interfaces:**
- Consumes: `RunRepository` (claim, complete, fail, scheduleRetry), `AppConfig`.
- Produces:
  - `AgentStep { run(run: Run, lease: Lease): Promise<void> }`, `AGENT_STEP`, `StubAgentStep`;
  - `PermanentError`, `classifyError(e): 'lease_lost' | 'permanent' | 'transient'`, `backoffSeconds(attempts): number`;
  - `WorkerService.processNextRun(): Promise<boolean>`, with constructor `(cfg: AppConfig, runs: RunRepository, agent: AgentStep)`;
  - `WorkerLoop.tick(): Promise<void>`. Later tasks add outbox, inbound and expiry to `tick`.

- [ ] **Step 1: Write the failing unit test for the error policy**

`src/worker/errors.spec.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { LeaseLostError } from '../runs/run';
import { backoffSeconds, classifyError, PermanentError } from './errors';

const apiError = (status: number) => Anthropic.APIError.generate(status, undefined, `status ${status}`, new Headers());

describe('classifyError', () => {
  it.each([
    [new LeaseLostError('r'), 'lease_lost'],
    [new PermanentError('x'), 'permanent'],
    [apiError(429), 'transient'],
    [apiError(529), 'transient'],
    [apiError(500), 'transient'],
    [apiError(400), 'permanent'],
    [apiError(401), 'permanent'],
    [apiError(404), 'permanent'],
    [new Error('socket hang up'), 'transient'],
  ])('%p -> %s', (e, kind) => {
    expect(classifyError(e)).toBe(kind);
  });
});

describe('backoffSeconds', () => {
  it('grows exponentially from 5s and caps at 300s', () => {
    expect([1, 2, 3, 4, 7, 20].map(backoffSeconds)).toEqual([5, 10, 20, 40, 300, 300]);
  });
});
```

Run: `npm test -- errors`
Expected: FAIL with "Cannot find module './errors'". If `APIError.generate` has a different signature in the installed SDK, let the compiler error guide the argument list. The intent is an `APIError` subclass with that HTTP status.

- [ ] **Step 2: Implement the error policy and AgentStep**

`src/worker/errors.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { LeaseLostError } from '../runs/run';

/** Errors that must not be retried: the run goes to FAILED. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export type ErrorKind = 'lease_lost' | 'permanent' | 'transient';

export function classifyError(e: unknown): ErrorKind {
  if (e instanceof LeaseLostError) return 'lease_lost';
  if (e instanceof PermanentError) return 'permanent';
  if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
    const s = e.status;
    if (s === 408 || s === 409 || s === 429 || s >= 500) return 'transient';
    if (s >= 400) return 'permanent';
  }
  // connection errors and unknown failures: retry; MAX_ATTEMPTS bounds it
  return 'transient';
}

export function backoffSeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}
```

`src/worker/agent-step.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Lease, Run } from '../runs/run';
import { RunRepository } from '../runs/run.repository';

/**
 * One processing pass over a claimed run. It must leave the run COMPLETED, FAILED or
 * WAITING_APPROVAL, or throw (the worker applies the retry policy).
 */
export interface AgentStep {
  run(run: Run, lease: Lease): Promise<void>;
}
export const AGENT_STEP = Symbol('AGENT_STEP');

/** F1 stub: completes every run. Replaced by AgentRunner in F2. */
@Injectable()
export class StubAgentStep implements AgentStep {
  constructor(private readonly runs: RunRepository) {}
  async run(_run: Run, lease: Lease): Promise<void> {
    await this.runs.complete(lease);
  }
}
```

Run: `npm test -- errors`
Expected: PASS.

- [ ] **Step 3: Write the failing worker tests**

`test/worker/worker.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { RunRepository } from '../../src/runs/run.repository';
import { AgentStep, StubAgentStep } from '../../src/worker/agent-step';
import { PermanentError } from '../../src/worker/errors';
import { WorkerService } from '../../src/worker/worker.service';
import { testConfig } from '../helpers/config';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

describe('WorkerService', () => {
  let prisma: PrismaClient;
  let runs: RunRepository;
  beforeAll(() => {
    prisma = newPrisma();
    runs = new RunRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  const worker = (agent: AgentStep, cfg: Record<string, string> = {}) => new WorkerService(testConfig(cfg), runs, agent);
  const throwing = (e: Error): AgentStep => ({ run: async () => { throw e; } });

  it('processes a PENDING run with the stub to COMPLETED', async () => {
    const r = await runs.create(validInput());
    expect(await worker(new StubAgentStep(runs)).processNextRun()).toBe(true);
    expect((await runs.findById(r.id))?.status).toBe('COMPLETED');
    expect(await worker(new StubAgentStep(runs)).processNextRun()).toBe(false);
  });

  it('schedules a retry with backoff on a transient error', async () => {
    const r = await runs.create(validInput());
    await worker(throwing(new Error('socket hang up'))).processNextRun();
    const row = await prisma.run.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: 'PENDING', lastError: 'socket hang up', attempts: 1 });
    expect(row.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('fails the run on a permanent error', async () => {
    const r = await runs.create(validInput());
    await worker(throwing(new PermanentError('bad input'))).processNextRun();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'FAILED', lastError: 'bad input' });
  });

  it('fails the run once attempts exceed MAX_ATTEMPTS, without calling the agent', async () => {
    const r = await runs.create(validInput());
    await prisma.$executeRaw`UPDATE runs SET attempts = 2, last_error = 'previous' WHERE id = ${r.id}::uuid`;
    const agent = { run: jest.fn() };
    await worker(agent, { MAX_ATTEMPTS: '2' }).processNextRun();
    expect(agent.run).not.toHaveBeenCalled();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: r.id } }))
      .toMatchObject({ status: 'FAILED', lastError: 'max attempts exceeded: previous' });
  });
});
```

`test/worker/claim.concurrency.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { RunRepository } from '../../src/runs/run.repository';
import { WorkerService } from '../../src/worker/worker.service';
import { testConfig } from '../helpers/config';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('I4 — at most one worker processes a run at a time', () => {
  const clients: PrismaClient[] = [];
  let seed: PrismaClient;
  beforeAll(() => {
    seed = newPrisma();
  });
  afterAll(async () => {
    await Promise.all([seed, ...clients].map((c) => c.$disconnect()));
  });
  beforeEach(() => truncateAll(seed));

  it('5 parallel workers over 40 runs process each run exactly once', async () => {
    const seedRepo = new RunRepository(seed);
    for (let i = 0; i < 40; i++) await seedRepo.create(validInput());

    const processed: string[] = [];
    const workers = Array.from({ length: 5 }, () => {
      const client = newPrisma(3);
      clients.push(client);
      const repo = new RunRepository(client);
      return new WorkerService(testConfig(), repo, {
        run: async (run, lease) => {
          processed.push(run.id);
          await sleep(5);
          await repo.complete(lease);
        },
      });
    });

    await Promise.all(workers.map(async (w) => { while (await w.processNextRun()) { /* drain */ } }));

    expect(processed).toHaveLength(40);
    expect(new Set(processed).size).toBe(40);
    expect(await seed.run.count({ where: { status: 'COMPLETED', attempts: 1 } })).toBe(40);
  });
});
```

Run: `npm run test:int -- worker`
Expected: FAIL with "Cannot find module '../../src/worker/worker.service'".

- [ ] **Step 4: Implement WorkerService, WorkerLoop and the module**

`src/worker/worker.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { LeaseLostError } from '../runs/run';
import { RunRepository } from '../runs/run.repository';
import { AGENT_STEP, AgentStep } from './agent-step';
import { backoffSeconds, classifyError } from './errors';

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly runs: RunRepository,
    @Inject(AGENT_STEP) private readonly agent: AgentStep,
  ) {}

  /** Claims and processes one run. Returns false when nothing was claimable. */
  async processNextRun(): Promise<boolean> {
    const claimed = await this.runs.claim(this.cfg.LEASE_SECONDS);
    if (!claimed) return false;
    const { run, lease } = claimed;

    if (run.attempts > this.cfg.MAX_ATTEMPTS) {
      await this.ignoreLeaseLost(() => this.runs.fail(lease, `max attempts exceeded: ${run.lastError ?? 'unknown'}`));
      return true;
    }

    try {
      await this.agent.run(run, lease);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const kind = classifyError(e);
      if (kind === 'lease_lost') {
        this.logger.warn(message);
      } else if (kind === 'permanent') {
        await this.ignoreLeaseLost(() => this.runs.fail(lease, message));
      } else {
        await this.ignoreLeaseLost(() => this.runs.scheduleRetry(lease, message, backoffSeconds(run.attempts)));
      }
    }
    return true;
  }

  private async ignoreLeaseLost(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof LeaseLostError)) throw e;
      this.logger.warn(e.message);
    }
  }
}
```

`src/worker/worker.loop.ts`:

```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { WorkerService } from './worker.service';

const RUNS_PER_TICK = 10;

/** Polls on WORKER_POLL_MS. Each tick drains runs, then side tasks (added in F3–F5). */
@Injectable()
export class WorkerLoop implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerLoop.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly worker: WorkerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.WORKER_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.WORKER_POLL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let i = 0; i < RUNS_PER_TICK && (await this.worker.processNextRun()); i++) {
        /* keep draining */
      }
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : String(e));
    } finally {
      this.busy = false;
    }
  }
}
```

`src/worker/worker.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AGENT_STEP, StubAgentStep } from './agent-step';
import { WorkerLoop } from './worker.loop';
import { WorkerService } from './worker.service';

@Module({
  providers: [{ provide: AGENT_STEP, useClass: StubAgentStep }, WorkerService, WorkerLoop],
  exports: [WorkerService, WorkerLoop],
})
export class WorkerModule {}
```

Add `WorkerModule` to the imports of `AppModule`.

- [ ] **Step 5: Run the tests**

Run: `npm run test:int -- worker`
Expected: PASS (both `worker.int-spec` and `claim.concurrency.int-spec`).

- [ ] **Step 6: Stress script and the 20-run acceptance**

`scripts/stress.sh`:

```bash
#!/usr/bin/env bash
# F1 acceptance: the concurrency suite must pass 20 consecutive times.
set -euo pipefail
for i in $(seq 1 20); do
  echo "== stress run $i/20"
  npx jest -c jest.int.config.js --runInBand concurrency
done
echo "stress: 20/20 green"
```

Run: `chmod +x scripts/stress.sh && npm run test:stress`
Expected: last line `stress: 20/20 green`. Any failure is a real bug: use superpowers:systematic-debugging, never retry-until-green.

- [ ] **Step 7: Checkpoint.** Ask the user whether to commit.

---

# Phase F2 — Agent with tool pause

### Task 9: `approval_requests` and `actions` schema, repositories, run view

**Files:**
- Create: `src/approvals/subject-token.ts`, `src/approvals/approval.repository.ts`, `src/actions/action.repository.ts`
- Modify: `prisma/schema.prisma`, `src/prisma/database.module.ts` (add both repositories), `src/runs/run.repository.ts` (add `toWaitingApproval`, `resumeFromDecision`), `src/runs/runs.service.ts` (approval and action in the view)
- Test: `src/approvals/subject-token.spec.ts`, `test/approvals/repositories.int-spec.ts`

**Interfaces:**
- Consumes: `Db`, `Lease`, `LeaseLostError`, `appendRunEvent`.
- Produces:
  - `newSubjectToken(): string`;
  - `ApprovalStatus`, `Decision`, `ApprovalRequest`;
  - `ApprovalRepository`:
    - `createIfAbsent(db: Db, p: { runId: string; toolUseId: string; approverEmail: string; summary: string; recommendation: 'APPROVE' | 'REJECT'; rationale: string; ttlHours: number }): Promise<void>`
    - `findByToolUse(db: Db, runId: string, toolUseId: string): Promise<ApprovalRequest | null>`
    - `findLatestForRun(db: Db, runId: string): Promise<ApprovalRequest | null>`
    - `findDecidedForRun(db: Db, runId: string): Promise<ApprovalRequest | null>`
  - `ActionType`, `ActionRecord`;
  - `ActionRepository`:
    - `recordIfAbsent(db: Db, p: { runId: string; toolUseId: string; type: ActionType; payload: Record<string, unknown> }): Promise<boolean>`
    - `findForRun(db: Db, runId: string): Promise<ActionRecord | null>`
  - `RunRepository`:
    - `toWaitingApproval(db: Db, lease: Lease): Promise<void>`
    - `resumeFromDecision(db: Db, runId: string): Promise<boolean>`

- [ ] **Step 1: Schema and migration**

In `prisma/schema.prisma`, add `approvals ApprovalRequest[]` and `actions Action[]` to `model Run`, then append:

```prisma
model ApprovalRequest {
  id                String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  runId             String    @map("run_id") @db.Uuid
  toolUseId         String    @map("tool_use_id")
  approverEmail     String    @map("approver_email")
  subjectToken      String    @unique @map("subject_token")
  summary           String
  recommendation    String
  rationale         String
  status            String
  decision          String?
  decisionNote      String?   @map("decision_note")
  decisionRawText   String?   @map("decision_raw_text")
  providerMessageId String?   @map("provider_message_id")
  providerThreadId  String?   @map("provider_thread_id")
  clarificationSent Boolean   @default(false) @map("clarification_sent")
  lastError         String?   @map("last_error")
  expiresAt         DateTime  @map("expires_at") @db.Timestamptz(3)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(3)
  run               Run       @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, toolUseId])
  @@index([providerThreadId])
  @@map("approval_requests")
}

model Action {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  runId     String   @map("run_id") @db.Uuid
  toolUseId String   @map("tool_use_id")
  type      String
  payload   Json
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  run       Run      @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, toolUseId])
  @@map("actions")
}
```

`rationale` is an addition to spec §4. The approval e-mail template needs it (Task 2).

Run: `npx prisma migrate dev --create-only --name approvals_actions`, then append to the generated `migration.sql`:

```sql
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_status_check"
  CHECK (status IN ('CREATED','SENT','DECIDED','EXPIRED'));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decision_check"
  CHECK (decision IS NULL OR decision IN ('APPROVED','REJECTED'));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_recommendation_check"
  CHECK (recommendation IN ('APPROVE','REJECT'));
ALTER TABLE "actions" ADD CONSTRAINT "actions_type_check"
  CHECK (type IN ('REIMBURSEMENT_APPROVED','REIMBURSEMENT_REJECTED'));
CREATE INDEX "approval_requests_open_idx" ON "approval_requests" ("expires_at") WHERE status IN ('CREATED','SENT');
```

Run: `npx prisma migrate dev && npx prisma generate`
Expected: applied.

- [ ] **Step 2: Write the failing tests**

`src/approvals/subject-token.spec.ts`:

```ts
import { SUBJECT_TOKEN_RE } from '../mail/templates';
import { newSubjectToken } from './subject-token';

describe('newSubjectToken', () => {
  it('produces 8 base32 chars that the subject regex recognizes', () => {
    for (let i = 0; i < 200; i++) {
      const t = newSubjectToken();
      expect(t).toMatch(/^[a-z2-7]{8}$/);
      expect(SUBJECT_TOKEN_RE.exec(`Re: [mailgate #${t}] x`)?.[1]).toBe(t);
    }
  });
  it('is practically unique', () => {
    expect(new Set(Array.from({ length: 1000 }, newSubjectToken)).size).toBe(1000);
  });
});
```

`test/approvals/repositories.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { ActionRepository } from '../../src/actions/action.repository';
import { ApprovalRepository } from '../../src/approvals/approval.repository';
import { RunRepository } from '../../src/runs/run.repository';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

describe('approval and action repositories', () => {
  let prisma: PrismaClient;
  let runs: RunRepository;
  let approvals: ApprovalRepository;
  let actions: ActionRepository;
  beforeAll(() => {
    prisma = newPrisma();
    runs = new RunRepository(prisma);
    approvals = new ApprovalRepository(prisma);
    actions = new ActionRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  const approvalParams = (runId: string) => ({
    runId, toolUseId: 'toolu_1', approverEmail: 'gestor@acme.test', summary: 's',
    recommendation: 'APPROVE' as const, rationale: 'r', ttlHours: 48,
  });

  it('createIfAbsent is idempotent per (run_id, tool_use_id) and sets token and expiry', async () => {
    const run = await runs.create(validInput());
    await approvals.createIfAbsent(prisma, approvalParams(run.id));
    await approvals.createIfAbsent(prisma, approvalParams(run.id));
    expect(await prisma.approvalRequest.count()).toBe(1);
    const a = (await approvals.findByToolUse(prisma, run.id, 'toolu_1'))!;
    expect(a).toMatchObject({ status: 'CREATED', decision: null, clarificationSent: false });
    expect(a.subjectToken).toMatch(/^[a-z2-7]{8}$/);
    const hours = (a.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
  });

  it('recordIfAbsent returns true then false and does not abort the surrounding transaction', async () => {
    const run = await runs.create(validInput());
    const p = { runId: run.id, toolUseId: 'toolu_x', type: 'REIMBURSEMENT_APPROVED' as const, payload: { reason: 'ok' } };
    const results = await prisma.$transaction(async (tx) => {
      const first = await actions.recordIfAbsent(tx, p);
      const second = await actions.recordIfAbsent(tx, p);
      const count = await tx.action.count(); // would throw "transaction is aborted" after a P2002
      return { first, second, count };
    });
    expect(results).toEqual({ first: true, second: false, count: 1 });
    expect((await actions.findForRun(prisma, run.id))?.toolUseId).toBe('toolu_x');
  });

  it('resumeFromDecision only moves WAITING_APPROVAL runs to PENDING and resets attempts', async () => {
    const run = await runs.create(validInput());
    expect(await runs.resumeFromDecision(prisma, run.id)).toBe(false);
    await prisma.run.update({ where: { id: run.id }, data: { status: 'WAITING_APPROVAL', attempts: 3 } });
    expect(await runs.resumeFromDecision(prisma, run.id)).toBe(true);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
  });
});
```

Run: `npm test -- subject-token && npm run test:int -- repositories`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/approvals/subject-token.ts`:

```ts
import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 40 random bits as 8 lowercase base32 chars (a-z2-7). */
export function newSubjectToken(): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of randomBytes(5)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return out;
}
```

`src/approvals/approval.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ApprovalRequest as ApprovalModel, PrismaClient } from '../generated/prisma/client';
import { Db } from '../prisma/db';
import { PrismaService } from '../prisma/prisma.service';
import { newSubjectToken } from './subject-token';

export type ApprovalStatus = 'CREATED' | 'SENT' | 'DECIDED' | 'EXPIRED';
export type Decision = 'APPROVED' | 'REJECTED';

export interface ApprovalRequest extends Omit<ApprovalModel, 'status' | 'decision' | 'recommendation'> {
  status: ApprovalStatus;
  decision: Decision | null;
  recommendation: 'APPROVE' | 'REJECT';
}

const toApproval = (m: ApprovalModel): ApprovalRequest => m as ApprovalRequest;

@Injectable()
export class ApprovalRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** INSERT ... ON CONFLICT DO NOTHING: safe inside transactions (convention 0002). */
  async createIfAbsent(
    db: Db,
    p: { runId: string; toolUseId: string; approverEmail: string; summary: string; recommendation: 'APPROVE' | 'REJECT'; rationale: string; ttlHours: number },
  ): Promise<void> {
    await db.$executeRaw`
      INSERT INTO approval_requests
        (id, run_id, tool_use_id, approver_email, subject_token, summary, recommendation, rationale, status, expires_at, created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${p.runId}::uuid, ${p.toolUseId}, ${p.approverEmail.toLowerCase()}, ${newSubjectToken()},
         ${p.summary}, ${p.recommendation}, ${p.rationale}, 'CREATED',
         now() + make_interval(hours => ${p.ttlHours}::int), now(), now())
      ON CONFLICT (run_id, tool_use_id) DO NOTHING`;
  }

  async findByToolUse(db: Db, runId: string, toolUseId: string): Promise<ApprovalRequest | null> {
    const m = await db.approvalRequest.findUnique({ where: { runId_toolUseId: { runId, toolUseId } } });
    return m ? toApproval(m) : null;
  }

  async findLatestForRun(db: Db, runId: string): Promise<ApprovalRequest | null> {
    const m = await db.approvalRequest.findFirst({ where: { runId }, orderBy: { createdAt: 'desc' } });
    return m ? toApproval(m) : null;
  }

  async findDecidedForRun(db: Db, runId: string): Promise<ApprovalRequest | null> {
    const m = await db.approvalRequest.findFirst({ where: { runId, status: 'DECIDED' }, orderBy: { createdAt: 'desc' } });
    return m ? toApproval(m) : null;
  }
}
```

`src/actions/action.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Action, Prisma, PrismaClient } from '../generated/prisma/client';
import { Db } from '../prisma/db';
import { PrismaService } from '../prisma/prisma.service';

export type ActionType = 'REIMBURSEMENT_APPROVED' | 'REIMBURSEMENT_REJECTED';
export type ActionRecord = Action;

@Injectable()
export class ActionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** I1: at most one action per (run_id, tool_use_id). Returns false when it already existed. */
  async recordIfAbsent(
    db: Db,
    p: { runId: string; toolUseId: string; type: ActionType; payload: Record<string, unknown> },
  ): Promise<boolean> {
    const { count } = await db.action.createMany({
      data: [{ runId: p.runId, toolUseId: p.toolUseId, type: p.type, payload: p.payload as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  findForRun(db: Db, runId: string): Promise<ActionRecord | null> {
    return db.action.findFirst({ where: { runId }, orderBy: { createdAt: 'asc' } });
  }
}
```

Add to `RunRepository`:

```ts
  /** request_approval: release the worker (I5). */
  async toWaitingApproval(db: Db, lease: Lease): Promise<void> {
    await this.fenced(db, lease, { status: 'WAITING_APPROVAL', leaseToken: null, leaseUntil: null, attempts: 0 });
  }

  /** Human decision recorded: make the run claimable again. False if it was not waiting. */
  async resumeFromDecision(db: Db, runId: string): Promise<boolean> {
    const { count } = await db.run.updateMany({
      where: { id: runId, status: 'WAITING_APPROVAL' },
      data: { status: 'PENDING', attempts: 0, leaseUntil: null, leaseToken: null },
    });
    return count === 1;
  }
```

Register `ApprovalRepository` and `ActionRepository` in `DatabaseModule` (`providers` and `exports`).

In `RunsService`, inject both repositories and replace `approval: null, action: null` in `getView`:

```ts
    const approval = await this.approvals.findLatestForRun(this.prisma, id);
    const action = await this.actions.findForRun(this.prisma, id);
    // ...
      approval: approval
        ? { status: approval.status, decision: approval.decision, note: approval.decisionNote, expiresAt: approval.expiresAt }
        : null,
      action: action ? { type: action.type, payload: action.payload, createdAt: action.createdAt } : null,
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- subject-token && npm run test:int`
Expected: PASS (all integration suites still green).

- [ ] **Step 5: Checkpoint.** Ask the user whether to commit.

---

### Task 10: LLM port, Anthropic client, tools, prompts, scripted fake

**Files:**
- Create: `src/agent/llm-client.ts`, `src/agent/anthropic-llm-client.ts`, `src/agent/tools.ts`, `src/agent/prompts.ts`, `test/fakes/scripted-llm.ts`
- Test: `src/agent/anthropic-llm-client.spec.ts`, `src/agent/tools.spec.ts`

**Interfaces:**
- Consumes: `AppConfig`, `ReimbursementInput`, `formatBRL`.
- Produces:
  - `LlmRequest { system: string; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[] }`;
  - `LlmClient { createMessage(req: LlmRequest): Promise<Anthropic.Message> }`, `LLM_CLIENT`, `ANTHROPIC_SDK`;
  - `AnthropicLlmClient`;
  - `REQUEST_APPROVAL = 'request_approval'`, `RECORD_DECISION = 'record_decision'`, `TOOLS: Anthropic.Tool[]`, `requestApprovalInput`, `recordDecisionInput` (zod);
  - `buildSystemPrompt(limitCents: number): string`, `buildInitialMessage(input: ReimbursementInput): string`;
  - test fakes `ScriptedLlmClient`, `toolUse(name, input, id?)`, `endTurn(text?)`, `stopWith(reason)`.

- [ ] **Step 1: Write the failing unit tests**

`src/agent/tools.spec.ts`:

```ts
import { recordDecisionInput, requestApprovalInput, TOOLS } from './tools';
import { buildInitialMessage, buildSystemPrompt } from './prompts';

describe('tools', () => {
  it('declares both tools as strict objects without extra properties', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['request_approval', 'record_decision']);
    for (const t of TOOLS) {
      expect((t as { strict?: boolean }).strict).toBe(true);
      expect(t.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
  it('validates inputs', () => {
    expect(recordDecisionInput.safeParse({ decision: 'APPROVED', reason: 'ok' }).success).toBe(true);
    expect(recordDecisionInput.safeParse({ decision: 'MAYBE', reason: 'ok' }).success).toBe(false);
    expect(requestApprovalInput.safeParse({ summary: 's', recommendation: 'APPROVE', rationale: 'r' }).success).toBe(true);
  });
});

describe('prompts', () => {
  it('states the limit in BRL and the approval rule', () => {
    const p = buildSystemPrompt(50000);
    expect(p).toContain('R$ 500,00');
    expect(p).toContain('request_approval');
    expect(buildSystemPrompt(50000)).toBe(p); // stable, cache-friendly
  });
  it('renders the request with the formatted amount', () => {
    expect(buildInitialMessage({ description: 'd', amountCents: 84000, category: 'TRAVEL', requesterEmail: 'a@x.t', approverEmail: 'g@x.t' }))
      .toContain('R$ 840,00');
  });
});
```

`src/agent/anthropic-llm-client.spec.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config/config';
import { AnthropicLlmClient } from './anthropic-llm-client';
import { TOOLS } from './tools';

const cfg = (extra: Record<string, string> = {}) => loadConfig({ DATABASE_URL: 'postgresql://x', ...extra });

describe('AnthropicLlmClient', () => {
  const req = { system: 'sys', tools: TOOLS, messages: [{ role: 'user' as const, content: 'hi' }] };

  it('sends model, adaptive thinking, one tool per turn and the server-side fallback', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'm' });
    const client = new AnthropicLlmClient(cfg(), { messages: { create } } as unknown as Anthropic);
    await client.createMessage(req);
    const [params, options] = create.mock.calls[0];
    expect(params).toMatchObject({
      model: 'claude-opus-5', thinking: { type: 'adaptive' }, system: 'sys', fallbacks: 'default',
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
    expect(options).toEqual({ headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } });
  });

  it('omits the fallback when ANTHROPIC_FALLBACK=off', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'm' });
    await new AnthropicLlmClient(cfg({ ANTHROPIC_FALLBACK: 'off' }), { messages: { create } } as unknown as Anthropic).createMessage(req);
    expect(create.mock.calls[0][0]).not.toHaveProperty('fallbacks');
    expect(create.mock.calls[0][1]).toBeUndefined();
  });
});
```

Run: `npm test -- agent`
Expected: FAIL (modules not found).

- [ ] **Step 2: Implement the port, client, tools and prompts**

`src/agent/llm-client.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';

export interface LlmRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

export interface LlmClient {
  createMessage(req: LlmRequest): Promise<Anthropic.Message>;
}

export const LLM_CLIENT = Symbol('LLM_CLIENT');
export const ANTHROPIC_SDK = Symbol('ANTHROPIC_SDK');
```

`src/agent/anthropic-llm-client.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ANTHROPIC_SDK, LlmClient, LlmRequest } from './llm-client';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

@Injectable()
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Optional() @Inject(ANTHROPIC_SDK) client?: Anthropic,
  ) {
    // SDK retries 408/409/429/5xx twice by default; the worker's backoff handles the rest
    this.client = client ?? new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  }

  createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.cfg.ANTHROPIC_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: req.system,
      tools: req.tools,
      messages: req.messages,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    };
    if (this.cfg.ANTHROPIC_FALLBACK === 'off') return this.client.messages.create(params);
    // server-side refusal fallback (beta, D018): extra body field + beta header
    return this.client.messages.create(
      { ...params, fallbacks: 'default' } as Anthropic.MessageCreateParamsNonStreaming,
      { headers: { 'anthropic-beta': FALLBACK_BETA } },
    );
  }
}
```

If the installed SDK types reject `thinking: { type: 'adaptive' }`, the SDK is too old. Upgrade `@anthropic-ai/sdk` to the latest version; do not remove the field.

`src/agent/tools.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export const REQUEST_APPROVAL = 'request_approval';
export const RECORD_DECISION = 'record_decision';

export const TOOLS: Anthropic.Tool[] = [
  {
    name: REQUEST_APPROVAL,
    description:
      'Pausa a análise e envia ao gestor um e-mail pedindo aprovação humana. Obrigatório antes de aprovar valores acima do limite de aprovação automática.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'recommendation', 'rationale'],
      properties: {
        summary: { type: 'string', description: 'Resumo do pedido para o gestor, em português, até 600 caracteres.' },
        recommendation: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        rationale: { type: 'string', description: 'Justificativa da recomendação, em português.' },
      },
    },
  },
  {
    name: RECORD_DECISION,
    description: 'Registra a decisão final sobre o reembolso. Chame uma única vez por pedido.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision', 'reason'],
      properties: {
        decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
        reason: { type: 'string', description: 'Motivo da decisão, em português.' },
      },
    },
  },
];

export const requestApprovalInput = z.object({
  summary: z.string().min(1),
  recommendation: z.enum(['APPROVE', 'REJECT']),
  rationale: z.string().min(1),
});

export const recordDecisionInput = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().min(1),
});
```

If `strict` is not part of `Anthropic.Tool` in the installed SDK, upgrade the SDK rather than casting.

`src/agent/prompts.ts`:

```ts
import { formatBRL } from '../mail/format';
import { CATEGORY_LABEL, ReimbursementInput } from '../runs/reimbursement-input';

/** Stable for a given limit: no timestamps or ids, so the prefix stays cacheable. */
export function buildSystemPrompt(limitCents: number): string {
  const limit = formatBRL(limitCents);
  return [
    'Você é um analista de reembolsos de despesas de uma empresa.',
    'Analise o pedido recebido e decida se deve ser aprovado ou recusado.',
    '',
    'Regras:',
    `- Pedidos de até ${limit} (inclusive) você pode aprovar ou recusar sozinho, chamando record_decision.`,
    `- Pedidos acima de ${limit} você pode recusar sozinho, mas para aprovar precisa SEMPRE chamar request_approval antes de record_decision.`,
    '- Depois de receber a decisão do gestor, chame record_decision com exatamente a mesma decisão.',
    '- Chame record_decision uma única vez. Depois disso, encerre com uma frase curta.',
    '- Valores estão em centavos de real (amountCents).',
  ].join('\n');
}

export function buildInitialMessage(input: ReimbursementInput): string {
  return [
    'Novo pedido de reembolso:',
    JSON.stringify(
      { ...input, amountFormatted: formatBRL(input.amountCents), categoryLabel: CATEGORY_LABEL[input.category] },
      null,
      2,
    ),
  ].join('\n');
}
```

- [ ] **Step 3: Write the scripted fake**

`test/fakes/scripted-llm.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { LlmClient, LlmRequest } from '../../src/agent/llm-client';

export class ScriptedLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: Array<Anthropic.Message | Error> = []) {}

  push(...steps: Array<Anthropic.Message | Error>): void {
    this.script.push(...steps);
  }

  async createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedLlmClient: script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
}

function message(content: unknown[], stop_reason: Anthropic.Message['stop_reason']): Anthropic.Message {
  return {
    id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-opus-5',
    content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

export const toolUse = (name: string, input: Record<string, unknown>, id = `toolu_${randomUUID()}`) =>
  message([{ type: 'tool_use', id, name, input }], 'tool_use');

export const endTurn = (text = 'Pronto.') => message([{ type: 'text', text, citations: null }], 'end_turn');

export const stopWith = (reason: Anthropic.Message['stop_reason']) => message([{ type: 'text', text: '', citations: null }], reason);
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- agent && npm run typecheck`
Expected: PASS, and the typecheck exits 0.

- [ ] **Step 5: Checkpoint.** Ask the user whether to commit.

---

### Task 11: AgentRunner — loop, `record_decision`, limit rule, I1

**Files:**
- Create: `src/agent/agent-runner.ts`, `src/agent/agent.module.ts`, `test/helpers/harness.ts`
- Modify: `src/worker/worker.module.ts` (`AGENT_STEP` → `AgentRunner`), `src/app.module.ts` (import `AgentModule` via `WorkerModule`)
- Test: `test/agent/agent-decision.int-spec.ts`

**Interfaces:**
- Consumes:
  - `LlmClient`, `TOOLS`, `REQUEST_APPROVAL`, `RECORD_DECISION`, `recordDecisionInput`, `requestApprovalInput`, `buildSystemPrompt`, `buildInitialMessage`;
  - `RunRepository`, `ApprovalRepository`, `ActionRepository`, `appendRunEvent`, `PermanentError`, `AgentStep`.
- Produces:
  - `AgentRunner implements AgentStep`, with constructor `(cfg: AppConfig, prisma: PrismaClient, runs: RunRepository, approvals: ApprovalRepository, actions: ActionRepository, llm: LlmClient)`;
  - test helper `buildHarness(prisma, { script?, cfg? })`, which returns `{ cfg, runs, approvals, actions, llm, agent, worker }`.

- [ ] **Step 1: Write the harness and the failing tests**

`test/helpers/harness.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { ActionRepository } from '../../src/actions/action.repository';
import { AgentRunner } from '../../src/agent/agent-runner';
import { ApprovalRepository } from '../../src/approvals/approval.repository';
import { PrismaClient } from '../../src/generated/prisma/client';
import { RunRepository } from '../../src/runs/run.repository';
import { WorkerService } from '../../src/worker/worker.service';
import { ScriptedLlmClient } from '../fakes/scripted-llm';
import { testConfig } from './config';

export function buildHarness(
  prisma: PrismaClient,
  opts: { script?: Array<Anthropic.Message | Error>; cfg?: Record<string, string> } = {},
) {
  const cfg = testConfig(opts.cfg);
  const runs = new RunRepository(prisma);
  const approvals = new ApprovalRepository(prisma);
  const actions = new ActionRepository(prisma);
  const llm = new ScriptedLlmClient(opts.script ?? []);
  const agent = new AgentRunner(cfg, prisma, runs, approvals, actions, llm);
  const worker = new WorkerService(cfg, runs, agent);
  return { cfg, runs, approvals, actions, llm, agent, worker };
}
```

`test/agent/agent-decision.int-spec.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '../../src/generated/prisma/client';
import { endTurn, stopWith, toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness } from '../helpers/harness';

const lastToolResult = (req: { messages: Anthropic.MessageParam[] }) => {
  const last = req.messages[req.messages.length - 1];
  return (last.content as Anthropic.ToolResultBlockParam[])[0];
};

describe('AgentRunner — decisions', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('approves alone at or below the limit and completes (boundary 50000)', async () => {
    const h = buildHarness(prisma, { script: [toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }), endTurn()] });
    const run = await h.runs.create(validInput({ amountCents: 50000 }));
    await h.worker.processNextRun();
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
    const action = await prisma.action.findFirstOrThrow({ where: { runId: run.id } });
    expect(action.type).toBe('REIMBURSEMENT_APPROVED');
    expect(action.payload).toMatchObject({ decidedBy: 'AGENT', amountCents: 50000 });
    const saved = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect((saved.messages as unknown[]).length).toBe(4); // user, assistant(tool_use), user(tool_result), assistant(end)
  });

  it('rejects APPROVED above the limit without human approval (is_error), no action', async () => {
    const h = buildHarness(prisma, { script: [toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }), endTurn()] });
    const run = await h.runs.create(validInput({ amountCents: 50001 }));
    await h.worker.processNextRun();
    const result = lastToolResult(h.llm.requests[1]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('request_approval');
    expect(await prisma.action.count()).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } }))
      .toMatchObject({ status: 'FAILED', lastError: 'agent ended without a decision' });
  });

  it('allows REJECTED above the limit without approval', async () => {
    const h = buildHarness(prisma, { script: [toolUse('record_decision', { decision: 'REJECTED', reason: 'sem nota' }), endTurn()] });
    const run = await h.runs.create(validInput({ amountCents: 900000 }));
    await h.worker.processNextRun();
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
  });

  it('refuses a second record_decision with a different tool_use id (one action only)', async () => {
    const h = buildHarness(prisma, {
      script: [
        toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }),
        toolUse('record_decision', { decision: 'REJECTED', reason: 'mudei de ideia' }),
        endTurn(),
      ],
    });
    const run = await h.runs.create(validInput({ amountCents: 1000 }));
    await h.worker.processNextRun();
    expect(lastToolResult(h.llm.requests[2]).is_error).toBe(true);
    expect(await prisma.action.count({ where: { runId: run.id } })).toBe(1);
    expect((await prisma.action.findFirstOrThrow({ where: { runId: run.id } })).type).toBe('REIMBURSEMENT_APPROVED');
  });

  it('I1 — re-executing record_decision after a crash does not duplicate the action', async () => {
    const h = buildHarness(prisma, { script: [endTurn()] });
    const run = await h.runs.create(validInput({ amountCents: 1000 }));
    // state right after a crash: tool_use persisted, action inserted, tool_result never persisted
    const crashed = toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }, 'toolu_crash');
    await prisma.run.update({
      where: { id: run.id },
      data: { messages: [{ role: 'user', content: 'pedido' }, { role: 'assistant', content: crashed.content }] as object[] },
    });
    await h.actions.recordIfAbsent(prisma, { runId: run.id, toolUseId: 'toolu_crash', type: 'REIMBURSEMENT_APPROVED', payload: {} });

    await h.worker.processNextRun();

    expect(await prisma.action.count({ where: { runId: run.id } })).toBe(1);
    expect(JSON.parse(String(lastToolResult(h.llm.requests[0]).content))).toMatchObject({ ok: true, alreadyRecorded: true });
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
  });

  it('fails when the model ends without a decision', async () => {
    const h = buildHarness(prisma, { script: [endTurn('Não sei.')] });
    const run = await h.runs.create(validInput());
    await h.worker.processNextRun();
    expect((await h.runs.findById(run.id))?.status).toBe('FAILED');
  });

  it('fails after MAX_TURNS assistant messages', async () => {
    const h = buildHarness(prisma, { cfg: { MAX_TURNS: '2' }, script: [toolUse('nope', {}), toolUse('nope', {}), toolUse('nope', {})] });
    const run = await h.runs.create(validInput());
    await h.worker.processNextRun();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', lastError: 'max turns (2) exceeded' });
  });

  it('fails on refusal and retries on rate limit', async () => {
    const refused = buildHarness(prisma, { script: [stopWith('refusal')] });
    const r1 = await refused.runs.create(validInput());
    await refused.worker.processNextRun();
    expect((await refused.runs.findById(r1.id))?.status).toBe('FAILED');

    await truncateAll(prisma);
    const limited = buildHarness(prisma, { script: [Anthropic.APIError.generate(429, undefined, 'rate limited', new Headers())] });
    const r2 = await limited.runs.create(validInput());
    await limited.worker.processNextRun();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: r2.id } })).toMatchObject({ status: 'PENDING' });
  });
});
```

Run: `npm run test:int -- agent-decision`
Expected: FAIL with "Cannot find module '../../src/agent/agent-runner'".

- [ ] **Step 2: Implement AgentRunner**

`src/agent/agent-runner.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable } from '@nestjs/common';
import { ActionRepository } from '../actions/action.repository';
import { ApprovalRepository } from '../approvals/approval.repository';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Lease, Run } from '../runs/run';
import { appendRunEvent } from '../runs/run-events';
import { RunRepository } from '../runs/run.repository';
import { AgentStep } from '../worker/agent-step';
import { PermanentError } from '../worker/errors';
import { LLM_CLIENT, LlmClient } from './llm-client';
import { buildInitialMessage, buildSystemPrompt } from './prompts';
import { RECORD_DECISION, recordDecisionInput, REQUEST_APPROVAL, requestApprovalInput, TOOLS } from './tools';

type ToolOutcome = { kind: 'result'; result: Anthropic.ToolResultBlockParam } | { kind: 'paused' };

const errorResult = (id: string, message: string): Anthropic.ToolResultBlockParam => ({
  type: 'tool_result', tool_use_id: id, content: message, is_error: true,
});
const okResult = (id: string, body: Record<string, unknown>): Anthropic.ToolResultBlockParam => ({
  type: 'tool_result', tool_use_id: id, content: JSON.stringify(body),
});

function toolUseOf(message: Anthropic.MessageParam): Anthropic.ToolUseBlockParam | undefined {
  if (message.role !== 'assistant' || typeof message.content === 'string') return undefined;
  return message.content.find((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
}

@Injectable()
export class AgentRunner implements AgentStep {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly runs: RunRepository,
    private readonly approvals: ApprovalRepository,
    private readonly actions: ActionRepository,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  async run(run: Run, lease: Lease): Promise<void> {
    let messages: Anthropic.MessageParam[] = [...run.messages];
    if (messages.length === 0) {
      messages = [{ role: 'user', content: buildInitialMessage(run.input) }];
      await this.save(lease, messages);
    }

    for (;;) {
      const last = messages[messages.length - 1];
      if (last.role === 'assistant') {
        const toolUse = toolUseOf(last);
        if (!toolUse) return this.finish(run, lease);
        const outcome = await this.executeTool(run, lease, toolUse);
        if (outcome.kind === 'paused') return;
        messages = [...messages, { role: 'user', content: [outcome.result] }];
        await this.save(lease, messages);
        continue;
      }

      const turns = messages.filter((m) => m.role === 'assistant').length;
      if (turns >= this.cfg.MAX_TURNS) throw new PermanentError(`max turns (${this.cfg.MAX_TURNS}) exceeded`);

      const response = await this.llm.createMessage({
        system: buildSystemPrompt(this.cfg.AUTO_APPROVE_LIMIT_CENTS),
        tools: TOOLS,
        messages,
      });
      if (response.stop_reason === 'refusal') throw new PermanentError('model refused the request');
      if (response.stop_reason === 'max_tokens') throw new Error('model hit max_tokens');

      // append-only, verbatim (convention 0005); persisted BEFORE any tool runs (D010)
      messages = [...messages, { role: 'assistant', content: response.content }];
      await this.save(lease, messages);
    }
  }

  private save(lease: Lease, messages: Anthropic.MessageParam[]): Promise<void> {
    return this.runs.saveMessages(lease, messages, this.cfg.LEASE_SECONDS);
  }

  private async finish(run: Run, lease: Lease): Promise<void> {
    const action = await this.actions.findForRun(this.prisma, run.id);
    if (!action) throw new PermanentError('agent ended without a decision');
    await this.runs.complete(lease);
  }

  private async executeTool(run: Run, lease: Lease, block: Anthropic.ToolUseBlockParam): Promise<ToolOutcome> {
    switch (block.name) {
      case RECORD_DECISION:
        return { kind: 'result', result: await this.recordDecision(run, block) };
      case REQUEST_APPROVAL:
        return this.requestApproval(run, lease, block);
      default:
        return { kind: 'result', result: errorResult(block.id, `ferramenta desconhecida: ${block.name}`) };
    }
  }

  private async recordDecision(run: Run, block: Anthropic.ToolUseBlockParam): Promise<Anthropic.ToolResultBlockParam> {
    const parsed = recordDecisionInput.safeParse(block.input);
    if (!parsed.success) return errorResult(block.id, `entrada inválida: ${parsed.error.message}`);
    const { decision, reason } = parsed.data;

    const existing = await this.actions.findForRun(this.prisma, run.id);
    if (existing && existing.toolUseId !== block.id) {
      return errorResult(block.id, 'decisão já registrada para este pedido; encerre sem chamar ferramentas');
    }

    const human = await this.approvals.findDecidedForRun(this.prisma, run.id);
    if (human && human.decision !== decision) {
      return errorResult(block.id, `a decisão do gestor foi ${human.decision}; registre exatamente essa decisão`);
    }
    if (!human && decision === 'APPROVED' && run.input.amountCents > this.cfg.AUTO_APPROVE_LIMIT_CENTS) {
      return errorResult(block.id, 'valor acima do limite de aprovação automática: chame request_approval antes de aprovar');
    }

    const inserted = await this.prisma.$transaction(async (tx) => {
      const ok = await this.actions.recordIfAbsent(tx, {
        runId: run.id,
        toolUseId: block.id,
        type: decision === 'APPROVED' ? 'REIMBURSEMENT_APPROVED' : 'REIMBURSEMENT_REJECTED',
        payload: { reason, amountCents: run.input.amountCents, decidedBy: human ? 'HUMAN' : 'AGENT' },
      });
      if (ok) await appendRunEvent(tx, run.id, 'ACTION_RECORDED', { decision, toolUseId: block.id });
      return ok;
    });
    return okResult(block.id, { ok: true, alreadyRecorded: !inserted });
  }

  private async requestApproval(run: Run, lease: Lease, block: Anthropic.ToolUseBlockParam): Promise<ToolOutcome> {
    // implemented in Task 12
    throw new PermanentError(`request_approval not implemented (${run.id}, ${lease.runId}, ${block.id})`);
  }
}
```

The `requestApproval` stub is replaced in the next task. Its test (Task 12) drives the change.

`src/agent/agent.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AgentRunner } from './agent-runner';
import { AnthropicLlmClient } from './anthropic-llm-client';
import { LLM_CLIENT } from './llm-client';

@Module({
  providers: [{ provide: LLM_CLIENT, useClass: AnthropicLlmClient }, AgentRunner],
  exports: [AgentRunner, LLM_CLIENT],
})
export class AgentModule {}
```

In `src/worker/worker.module.ts`, import `AgentModule` and replace the stub provider with `{ provide: AGENT_STEP, useExisting: AgentRunner }`. Keep the `StubAgentStep` class, because the F1 tests still use it.

- [ ] **Step 3: Run the tests**

Run: `npm run test:int`
Expected: PASS, including every earlier suite.

- [ ] **Step 4: Checkpoint.** Ask the user whether to commit.

---

### Task 12: `request_approval` pause (I5) and resume from the human decision

**Files:**
- Modify: `src/agent/agent-runner.ts` (replace the `requestApproval` stub)
- Test: `test/agent/agent-pause.int-spec.ts`

**Interfaces:**
- Consumes: `ApprovalRepository.createIfAbsent`, `findByToolUse`; `RunRepository.toWaitingApproval`, `resumeFromDecision`; `appendRunEvent`.
- Produces: a run that pauses in `WAITING_APPROVAL` with no lease. The contract F4 relies on: after the approval is `DECIDED` and `resumeFromDecision`, the next claim continues from the pending `request_approval` tool_use.

- [ ] **Step 1: Write the failing tests**

`test/agent/agent-pause.int-spec.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '../../src/generated/prisma/client';
import { endTurn, toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness } from '../helpers/harness';

const ASK = { summary: 'Hotel 2 diárias', recommendation: 'APPROVE', rationale: 'dentro da média' };

async function decide(prisma: PrismaClient, runId: string, decision: 'APPROVED' | 'REJECTED', note = 'ok') {
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.updateMany({ where: { runId }, data: { status: 'DECIDED', decision, decisionNote: note } });
    await tx.run.updateMany({ where: { id: runId, status: 'WAITING_APPROVAL' }, data: { status: 'PENDING', attempts: 0 } });
  });
}

describe('AgentRunner — pause and resume', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('I5 — request_approval parks the run without a lease and creates the approval', async () => {
    const h = buildHarness(prisma, { script: [toolUse('request_approval', ASK, 'toolu_ask')] });
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ status: 'WAITING_APPROVAL', leaseToken: null, leaseUntil: null, attempts: 0 });
    const approval = await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } });
    expect(approval).toMatchObject({ status: 'CREATED', toolUseId: 'toolu_ask', approverEmail: 'gestor@acme.test', summary: ASK.summary });
    expect(await h.runs.claim(60)).toBeNull();
    expect(h.llm.requests).toHaveLength(1);
    expect(await prisma.runEvent.count({ where: { runId: run.id, type: 'APPROVAL_REQUESTED' } })).toBe(1);
  });

  it('resumes after APPROVED: tool_result carries the decision, action by HUMAN, run COMPLETED', async () => {
    const h = buildHarness(prisma, { script: [toolUse('request_approval', ASK, 'toolu_ask')] });
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    await decide(prisma, run.id, 'APPROVED', 'pode aprovar');

    h.llm.push(toolUse('record_decision', { decision: 'APPROVED', reason: 'aprovado pelo gestor' }), endTurn());
    await h.worker.processNextRun();

    const resumedReq = h.llm.requests[1];
    const last = resumedReq.messages[resumedReq.messages.length - 1];
    const result = (last.content as Anthropic.ToolResultBlockParam[])[0];
    expect(result.tool_use_id).toBe('toolu_ask');
    expect(JSON.parse(String(result.content))).toEqual({ decision: 'APPROVED', note: 'pode aprovar', decidedBy: 'gestor@acme.test' });
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
    expect((await prisma.action.findFirstOrThrow({ where: { runId: run.id } })).payload).toMatchObject({ decidedBy: 'HUMAN' });
    expect(await prisma.runEvent.count({ where: { runId: run.id, type: 'RESUMED' } })).toBe(1);
  });

  it('refuses a record_decision that contradicts the human decision', async () => {
    const h = buildHarness(prisma, { script: [toolUse('request_approval', ASK)] });
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    await decide(prisma, run.id, 'REJECTED', 'falta nota fiscal');

    h.llm.push(
      toolUse('record_decision', { decision: 'APPROVED', reason: 'x' }),
      toolUse('record_decision', { decision: 'REJECTED', reason: 'falta nota fiscal' }),
      endTurn(),
    );
    await h.worker.processNextRun();

    const afterWrong = h.llm.requests[2].messages.at(-1)!;
    expect((afterWrong.content as Anthropic.ToolResultBlockParam[])[0].is_error).toBe(true);
    expect((await prisma.action.findFirstOrThrow({ where: { runId: run.id } })).type).toBe('REIMBURSEMENT_REJECTED');
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
  });

  it('F2 acceptance — below the limit completes alone; above stops in WAITING_APPROVAL', async () => {
    const h = buildHarness(prisma, {
      script: [toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }), endTurn(), toolUse('request_approval', ASK)],
    });
    const small = await h.runs.create(validInput({ amountCents: 30000 }));
    const big = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    await h.worker.processNextRun();
    expect((await h.runs.findById(small.id))?.status).toBe('COMPLETED');
    expect((await h.runs.findById(big.id))?.status).toBe('WAITING_APPROVAL');
  });
});
```

Run: `npm run test:int -- agent-pause`
Expected: FAIL. The run is `FAILED` with "request_approval not implemented".

- [ ] **Step 2: Implement `requestApproval`**

Replace the stub in `AgentRunner`:

```ts
  private async requestApproval(run: Run, lease: Lease, block: Anthropic.ToolUseBlockParam): Promise<ToolOutcome> {
    const existing = await this.approvals.findByToolUse(this.prisma, run.id, block.id);

    if (existing?.status === 'DECIDED') {
      await appendRunEvent(this.prisma, run.id, 'RESUMED', { approvalId: existing.id, decision: existing.decision });
      return {
        kind: 'result',
        result: okResult(block.id, { decision: existing.decision, note: existing.decisionNote, decidedBy: existing.approverEmail }),
      };
    }
    if (existing?.status === 'EXPIRED') throw new PermanentError('approval request expired');

    const parsed = requestApprovalInput.safeParse(block.input);
    if (!parsed.success) return { kind: 'result', result: errorResult(block.id, `entrada inválida: ${parsed.error.message}`) };

    await this.prisma.$transaction(async (tx) => {
      await this.approvals.createIfAbsent(tx, {
        runId: run.id,
        toolUseId: block.id,
        approverEmail: run.input.approverEmail,
        ...parsed.data,
        ttlHours: this.cfg.APPROVAL_TTL_HOURS,
      });
      await this.runs.toWaitingApproval(tx, lease); // I5: lease released, attempts reset
      await appendRunEvent(tx, run.id, 'APPROVAL_REQUESTED', { toolUseId: block.id });
    });
    return { kind: 'paused' };
  }
```

- [ ] **Step 3: Run the tests**

Run: `npm run test:int`
Expected: PASS (all suites).

- [ ] **Step 4: Checkpoint.** F2 acceptance is met by the last test. Ask the user whether to commit.

---

# Phase F3 — Sending the approval e-mail

### Task 13: MailProvider port, AgentMail adapter, fake, spike script

**Files:**
- Create: `src/mail/mail-provider.ts`, `src/mail/agentmail.provider.ts`, `test/fakes/fake-mail.ts`, `scripts/agentmail-spike.ts`
- Test: `src/mail/agentmail.provider.spec.ts`

**Interfaces:**
- Consumes: `AppConfig`.
- Produces:
  - `SendParams`, `ReplyParams`, `InboundEvent`, `MailProvider`, `MAIL_PROVIDER`, `InvalidSignatureError`;
  - `extractAddress(from: string): string`, `toInboundEvent(eventId: string, body: unknown): InboundEvent`;
  - `AgentMailProvider`;
  - `FakeMailProvider` (test), with `sent`, `replies`, `failNextSends`, `deliveredSendKeys()`, `signedRequest(eventId, body)`.

- [ ] **Step 1: Install**

Run: `npm i -E agentmail svix`

Confirm the pinned `agentmail` version in `package.json` (0.5.x at research time).

- [ ] **Step 2: Write the failing unit tests**

`src/mail/agentmail.provider.spec.ts`:

```ts
import { Webhook } from 'svix';
import { loadConfig } from '../config/config';
import { AgentMailProvider } from './agentmail.provider';
import { extractAddress, InvalidSignatureError, toInboundEvent } from './mail-provider';

const SECRET = `whsec_${Buffer.from('mailgate-test-secret-0123456789').toString('base64')}`;

const received = {
  event_type: 'message.received',
  event_id: 'evt_1',
  message: {
    message_id: '<m2@agentmail.to>', thread_id: 'thr_1', from: 'Gestor <GESTOR@ACME.TEST>',
    subject: 'Re: [mailgate #abcd2345] Reembolso', text: 'pode aprovar\n\n> citado', extracted_text: 'pode aprovar',
  },
};

describe('extractAddress', () => {
  it.each([
    ['Gestor <GESTOR@ACME.TEST>', 'gestor@acme.test'],
    ['gestor@acme.test', 'gestor@acme.test'],
    ['  "Silva, J." <j.silva@acme.test> ', 'j.silva@acme.test'],
  ])('%s -> %s', (input, out) => expect(extractAddress(input)).toBe(out));
});

describe('toInboundEvent', () => {
  it('normalizes a message.received payload', () => {
    expect(toInboundEvent('msg_svix_1', received)).toEqual({
      eventId: 'msg_svix_1', type: 'message.received', threadId: 'thr_1', messageId: '<m2@agentmail.to>',
      from: 'gestor@acme.test', subject: 'Re: [mailgate #abcd2345] Reembolso', text: 'pode aprovar', raw: received,
    });
  });
  it('falls back to text and tolerates a missing thread id', () => {
    const e = toInboundEvent('x', { event_type: 'message.received', message: { message_id: 'm', from: 'a@b.c', subject: 's', text: 'aprovo' } });
    expect(e.threadId).toBeNull();
    expect(e.text).toBe('aprovo');
  });
});

describe('AgentMailProvider.parseInbound', () => {
  const provider = new AgentMailProvider(loadConfig({ DATABASE_URL: 'postgresql://x', AGENTMAIL_WEBHOOK_SECRET: SECRET, AGENTMAIL_API_KEY: 'k', AGENTMAIL_INBOX_ID: 'i' }));
  const body = JSON.stringify(received);
  const signed = (payload: string, id = 'msg_svix_1') => {
    const ts = new Date();
    return {
      'svix-id': id,
      'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
      'svix-signature': new Webhook(SECRET).sign(id, ts, payload),
    };
  };

  it('accepts a valid Svix signature and uses svix-id as eventId', () => {
    expect(provider.parseInbound(Buffer.from(body), signed(body)).eventId).toBe('msg_svix_1');
  });
  it('rejects a tampered body', () => {
    expect(() => provider.parseInbound(Buffer.from(body.replace('aprovar', 'recusar')), signed(body))).toThrow(InvalidSignatureError);
  });
  it('rejects missing headers', () => {
    expect(() => provider.parseInbound(Buffer.from(body), {})).toThrow(InvalidSignatureError);
  });
});
```

Run: `npm test -- agentmail`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the port and the adapter**

`src/mail/mail-provider.ts`:

```ts
export interface SendParams {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface ReplyParams {
  messageId: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface InboundEvent {
  eventId: string;
  type: string;
  threadId: string | null;
  messageId: string;
  from: string;
  subject: string;
  text: string;
  raw: unknown;
}

export interface MailProvider {
  send(p: SendParams): Promise<{ messageId: string; threadId: string }>;
  reply(p: ReplyParams): Promise<{ messageId: string }>;
  /** Verifies the signature; throws InvalidSignatureError. */
  parseInbound(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): InboundEvent;
}

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

export class InvalidSignatureError extends Error {
  constructor(message = 'invalid webhook signature') {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

/** "Nome <E@X>" -> "e@x" */
export function extractAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

type Loose = Record<string, unknown> | undefined;

export function toInboundEvent(eventId: string, body: unknown): InboundEvent {
  const b = (body ?? {}) as Record<string, unknown>;
  const m = (b.message ?? {}) as Record<string, unknown>;
  const thread = b.thread as Loose;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    eventId,
    type: str(b.event_type) || str(b.type),
    threadId: str(m.thread_id) || str(thread?.thread_id) || null,
    messageId: str(m.message_id),
    from: extractAddress(str(m.from)),
    subject: str(m.subject),
    text: str(m.extracted_text) || str(m.text),
    raw: body,
  };
}
```

`src/mail/agentmail.provider.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { AgentMailClient } from 'agentmail';
import { Webhook } from 'svix';
import { APP_CONFIG, AppConfig } from '../config/config';
import { InboundEvent, InvalidSignatureError, MailProvider, ReplyParams, SendParams, toInboundEvent } from './mail-provider';

const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

@Injectable()
export class AgentMailProvider implements MailProvider {
  private readonly client: AgentMailClient;
  private readonly webhook: Webhook | null;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.client = new AgentMailClient({ apiKey: cfg.AGENTMAIL_API_KEY ?? '' });
    this.webhook = cfg.AGENTMAIL_WEBHOOK_SECRET ? new Webhook(cfg.AGENTMAIL_WEBHOOK_SECRET) : null;
  }

  private inbox(): string {
    if (!this.cfg.AGENTMAIL_INBOX_ID) throw new Error('AGENTMAIL_INBOX_ID not configured');
    return this.cfg.AGENTMAIL_INBOX_ID;
  }

  async send(p: SendParams): Promise<{ messageId: string; threadId: string }> {
    const res = await this.client.inboxes.messages.send(
      this.inbox(),
      { to: p.to, subject: p.subject, text: p.text, html: p.html },
      { headers: { 'Idempotency-Key': p.idempotencyKey } },
    );
    return { messageId: res.messageId, threadId: res.threadId };
  }

  async reply(p: ReplyParams): Promise<{ messageId: string }> {
    const res = await this.client.inboxes.messages.reply(
      this.inbox(),
      p.messageId,
      { text: p.text, html: p.html },
      { headers: { 'Idempotency-Key': p.idempotencyKey } },
    );
    return { messageId: res.messageId };
  }

  parseInbound(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): InboundEvent {
    if (!this.webhook) throw new InvalidSignatureError('webhook secret not configured');
    const svix = {
      'svix-id': header(headers, 'svix-id') ?? '',
      'svix-timestamp': header(headers, 'svix-timestamp') ?? '',
      'svix-signature': header(headers, 'svix-signature') ?? '',
    };
    let body: unknown;
    try {
      body = this.webhook.verify(rawBody.toString('utf8'), svix);
    } catch {
      throw new InvalidSignatureError();
    }
    return toInboundEvent(svix['svix-id'], body);
  }
}
```

The SDK's method names and option shapes (`inboxes.messages.send` / `reply`, the request-options third argument, `messageId` / `threadId` on the response) come from RESEARCH Q1. If the compiler disagrees with the installed version, follow the compiler and the SDK README, keep the behavior, and record the difference in the LEDGER.

- [ ] **Step 4: Write the fake**

`test/fakes/fake-mail.ts`:

```ts
import { randomUUID } from 'node:crypto';
import {
  InboundEvent, InvalidSignatureError, MailProvider, ReplyParams, SendParams, toInboundEvent,
} from '../../src/mail/mail-provider';

/** In-memory provider with idempotency-key semantics like AgentMail (same key -> same result, no second delivery). */
export class FakeMailProvider implements MailProvider {
  readonly sent: SendParams[] = [];
  readonly replies: ReplyParams[] = [];
  failNextSends = 0;
  failNextReplies = 0;
  private readonly sendByKey = new Map<string, { messageId: string; threadId: string }>();
  private readonly replyByKey = new Map<string, { messageId: string }>();

  async send(p: SendParams): Promise<{ messageId: string; threadId: string }> {
    if (this.failNextSends > 0) {
      this.failNextSends--;
      throw new Error('fake: provider unavailable');
    }
    const prior = this.sendByKey.get(p.idempotencyKey);
    if (prior) return prior;
    this.sent.push(p);
    const r = { messageId: `<m-${randomUUID()}@fake>`, threadId: `thr_${randomUUID()}` };
    this.sendByKey.set(p.idempotencyKey, r);
    return r;
  }

  async reply(p: ReplyParams): Promise<{ messageId: string }> {
    if (this.failNextReplies > 0) {
      this.failNextReplies--;
      throw new Error('fake: provider unavailable');
    }
    const prior = this.replyByKey.get(p.idempotencyKey);
    if (prior) return prior;
    this.replies.push(p);
    const r = { messageId: `<r-${randomUUID()}@fake>` };
    this.replyByKey.set(p.idempotencyKey, r);
    return r;
  }

  deliveredSendKeys(): string[] {
    return this.sent.map((s) => s.idempotencyKey);
  }

  parseInbound(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): InboundEvent {
    if (headers['x-fake-signature'] !== 'valid') throw new InvalidSignatureError();
    return toInboundEvent(String(headers['svix-id']), JSON.parse(rawBody.toString('utf8')));
  }

  /** Headers + body for a signed webhook request in HTTP tests. */
  static signedRequest(eventId: string, body: unknown) {
    return { headers: { 'svix-id': eventId, 'x-fake-signature': 'valid', 'content-type': 'application/json' }, body };
  }
}

export function replyPayload(p: { threadId: string | null; from: string; text: string; subject?: string; messageId?: string }) {
  return {
    event_type: 'message.received',
    message: {
      message_id: p.messageId ?? `<in-${randomUUID()}@fake>`,
      thread_id: p.threadId ?? undefined,
      from: p.from,
      subject: p.subject ?? 'Re: reembolso',
      text: p.text,
      extracted_text: p.text,
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- agentmail && npm run typecheck`
Expected: PASS and exit 0.

- [ ] **Step 6: Spike script (manual, needs the user's AgentMail account)**

`scripts/agentmail-spike.ts`:

```ts
import 'dotenv/config';
import { loadConfig } from '../src/config/config';
import { AgentMailProvider } from '../src/mail/agentmail.provider';

/** F3 spike (D005): confirms thread id and Idempotency-Key against the real API. */
async function main(): Promise<void> {
  const to = process.env.AGENTMAIL_SPIKE_TO;
  if (!to) throw new Error('set AGENTMAIL_SPIKE_TO');
  const provider = new AgentMailProvider(loadConfig());
  const key = `spike-${Date.now()}`;
  const p = { to, subject: '[mailgate spike] idempotency', text: 'spike', html: '<p>spike</p>', idempotencyKey: key };
  const a = await provider.send(p);
  const b = await provider.send(p);
  console.log({ first: a, second: b, idempotent: a.messageId === b.messageId && a.threadId === b.threadId });
}
void main();
```

Ask the user to provide `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` in `.env` (never paste secrets into chat), and an address `AGENTMAIL_SPIKE_TO` they can read. Then run `npx ts-node scripts/agentmail-spike.ts`.

Expected: `idempotent: true`, and a single e-mail arrives.

Record the outcome in `docs/e2e.md` under "Spike". If `idempotent: false`, stop and bring it to the user. It is a D005/D016 decision (Resend fallback, or accept the documented risk).

- [ ] **Step 7: Checkpoint.** Ask the user whether to commit.

---

### Task 14: Outbox — `CREATED` → `SENT`

**Files:**
- Create: `src/mail/outbox.service.ts`, `src/mail/mail.module.ts`
- Modify: `src/worker/worker.loop.ts` (call outbox), `src/worker/worker.module.ts` (import `MailModule`), `test/helpers/harness.ts` (add mail and outbox)
- Test: `test/mail/outbox.int-spec.ts`

**Interfaces:**
- Consumes: `MailProvider`, `renderApprovalEmail`, `appendRunEvent`, `ReimbursementInput`, `AppConfig.OUTBOX_BATCH`.
- Produces:
  - `OutboxService.dispatch(): Promise<number>`, which returns how many were marked `SENT`;
  - `MailModule`, which exports `MAIL_PROVIDER` and `OutboxService`;
  - `buildHarness(...)` now also returns `{ mail: FakeMailProvider, outbox: OutboxService }`.

- [ ] **Step 1: Extend the harness and write the failing tests**

In `test/helpers/harness.ts`, add:

```ts
import { OutboxService } from '../../src/mail/outbox.service';
import { FakeMailProvider } from '../fakes/fake-mail';
// inside buildHarness, before return:
  const mail = new FakeMailProvider();
  const outbox = new OutboxService(cfg, prisma, mail);
// and add `mail, outbox` to the returned object
```

`test/mail/outbox.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { OutboxService } from '../../src/mail/outbox.service';
import { toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness } from '../helpers/harness';

const ASK = { summary: 'Hotel 2 diárias', recommendation: 'APPROVE', rationale: 'dentro da média' };

describe('OutboxService', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  async function pausedRun(h: ReturnType<typeof buildHarness>) {
    h.llm.push(toolUse('request_approval', ASK));
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    return run;
  }

  it('sends the approval e-mail with the idempotency key and marks SENT', async () => {
    const h = buildHarness(prisma);
    const run = await pausedRun(h);
    expect(await h.outbox.dispatch()).toBe(1);

    const a = await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } });
    expect(a).toMatchObject({ status: 'SENT', lastError: null });
    expect(a.providerThreadId).toMatch(/^thr_/);
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]).toMatchObject({ to: 'gestor@acme.test', idempotencyKey: `approval-${a.id}` });
    expect(h.mail.sent[0].subject).toBe(`[mailgate #${a.subjectToken}] Reembolso de R$ 840,00 — aprovação necessária`);
    expect(h.mail.sent[0].text).toContain('Responda este e-mail com APROVO ou RECUSO');
    expect(await prisma.runEvent.count({ where: { runId: run.id, type: 'APPROVAL_SENT' } })).toBe(1);
    expect(await h.outbox.dispatch()).toBe(0);
  });

  it('keeps CREATED with last_error when sending fails, and sends on the next dispatch', async () => {
    const h = buildHarness(prisma);
    const run = await pausedRun(h);
    h.mail.failNextSends = 1;
    expect(await h.outbox.dispatch()).toBe(0);
    expect(await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } }))
      .toMatchObject({ status: 'CREATED', lastError: 'fake: provider unavailable' });

    expect(await h.outbox.dispatch()).toBe(1);
    expect((await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } })).status).toBe('SENT');
  });

  it('two concurrent dispatchers deliver one e-mail and mark SENT once', async () => {
    const h = buildHarness(prisma);
    await pausedRun(h);
    const other = new OutboxService(h.cfg, prisma, h.mail);
    await Promise.all([h.outbox.dispatch(), other.dispatch()]);
    expect(h.mail.deliveredSendKeys()).toHaveLength(1);
    expect(await prisma.runEvent.count({ where: { type: 'APPROVAL_SENT' } })).toBe(1);
  });
});
```

Run: `npm run test:int -- outbox`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement**

`src/mail/outbox.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementInput } from '../runs/reimbursement-input';
import { appendRunEvent } from '../runs/run-events';
import { MAIL_PROVIDER, MailProvider } from './mail-provider';
import { renderApprovalEmail } from './templates';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  /** Sends CREATED approval requests. Never sends inside a DB transaction (convention 0004). */
  async dispatch(): Promise<number> {
    const pending = await this.prisma.approvalRequest.findMany({
      where: { status: 'CREATED' },
      orderBy: { createdAt: 'asc' },
      take: this.cfg.OUTBOX_BATCH,
      include: { run: true },
    });

    let sent = 0;
    for (const a of pending) {
      const input = a.run.input as unknown as ReimbursementInput;
      const email = renderApprovalEmail({
        subjectToken: a.subjectToken,
        description: input.description,
        category: input.category,
        amountCents: input.amountCents,
        requesterEmail: input.requesterEmail,
        summary: a.summary,
        recommendation: a.recommendation as 'APPROVE' | 'REJECT',
        rationale: a.rationale,
        expiresAt: a.expiresAt,
      });
      try {
        const res = await this.mail.send({ to: a.approverEmail, ...email, idempotencyKey: `approval-${a.id}` });
        const marked = await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.approvalRequest.updateMany({
            where: { id: a.id, status: 'CREATED' },
            data: { status: 'SENT', providerMessageId: res.messageId, providerThreadId: res.threadId, lastError: null },
          });
          if (count === 1) await appendRunEvent(tx, a.runId, 'APPROVAL_SENT', { approvalId: a.id, threadId: res.threadId });
          return count === 1;
        });
        if (marked) sent++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(`send failed for approval ${a.id}: ${message}`);
        await this.prisma.approvalRequest.updateMany({ where: { id: a.id, status: 'CREATED' }, data: { lastError: message } });
      }
    }
    return sent;
  }
}
```

`src/mail/mail.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AgentMailProvider } from './agentmail.provider';
import { MAIL_PROVIDER } from './mail-provider';
import { OutboxService } from './outbox.service';

@Module({
  providers: [{ provide: MAIL_PROVIDER, useClass: AgentMailProvider }, OutboxService],
  exports: [MAIL_PROVIDER, OutboxService],
})
export class MailModule {}
```

In `WorkerModule`, add `MailModule` to `imports`. In `WorkerLoop`, inject `OutboxService` and call it after the runs drain in `tick()`:

```ts
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly worker: WorkerService,
    private readonly outbox: OutboxService,
  ) {}
  // in tick(), after the runs loop:
      await this.outbox.dispatch();
```

- [ ] **Step 3: Run the tests**

Run: `npm run test:int`
Expected: PASS (all suites).

- [ ] **Step 4: F3 acceptance (manual).** With real `.env` values, start `npm run start:dev` and `POST /runs` a run of 84000 with `approverEmail` set to the user's inbox. The e-mail must arrive and render like `docs/mocks/approval.html`. The approval must reach `SENT` in `GET /runs/:id`. This needs a real `ANTHROPIC_API_KEY`; ask the user to run it or to authorize the spend.

- [ ] **Step 5: Checkpoint.** Ask the user whether to commit.

---

### Task 14b: Configurable LLM provider (D022, ADR 0007)

Added mid-window (w5) at the user's request. The LLM port must run against a local LLM (Ollama, LM Studio) or an external AI API (Anthropic, OpenRouter, LiteLLM) chosen by env, on the same `@anthropic-ai/sdk` client pointed at an Anthropic Messages-compatible base URL. Research: RESEARCH.md Q5.

**Files:**
- Create: `src/agent/llm-sdk.ts`, `src/agent/llm-sdk.spec.ts`
- Modify: `src/config/config.ts`, `src/config/config.spec.ts`, `src/agent/anthropic-llm-client.ts`, `src/agent/anthropic-llm-client.spec.ts`, `.env.example`, `README.md` (the `.env` line)

**Interfaces:**
- Consumes: `AppConfig`, `LlmClient`, `LlmRequest`, `ANTHROPIC_SDK`.
- Produces:
  - config: `LLM_PROVIDER` (`anthropic` | `anthropic-compatible`, default `anthropic`), `LLM_BASE_URL` (optional URL), `LLM_MODEL` (default `claude-opus-5`), `LLM_API_KEY` (optional). `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are removed (renamed); `ANTHROPIC_FALLBACK` stays (Anthropic-only flag). Config refuses `LLM_PROVIDER=anthropic-compatible` without `LLM_BASE_URL`.
  - `createLlmSdk(cfg: AppConfig): Anthropic` — `new Anthropic({ apiKey, baseURL })`, where `baseURL` is `LLM_BASE_URL` when set and `apiKey` is `LLM_API_KEY`, or the placeholder `'not-needed'` when the provider is `anthropic-compatible` and no key is set (local servers ignore it; the SDK refuses a request with no credential). Task 16's classifier reuses it.
  - `isNativeAnthropic(cfg: AppConfig): boolean` — `cfg.LLM_PROVIDER === 'anthropic'`.

- [ ] **Step 1: Failing tests**

`src/config/config.spec.ts`: defaults include `LLM_PROVIDER: 'anthropic'`, `LLM_MODEL: 'claude-opus-5'`, `ANTHROPIC_FALLBACK: 'default'`; `loadConfig({ DATABASE_URL, LLM_PROVIDER: 'anthropic-compatible' })` throws; with `LLM_BASE_URL: 'http://localhost:11434'` it passes.

`src/agent/llm-sdk.spec.ts`: `createLlmSdk` returns a client whose `baseURL` is the configured URL (`http://localhost:11434`) and whose `apiKey` is `'not-needed'` for `anthropic-compatible` without a key; with provider `anthropic` and `LLM_API_KEY: 'k'` the `apiKey` is `'k'` and `baseURL` is the SDK default (`https://api.anthropic.com`). No network.

`src/agent/anthropic-llm-client.spec.ts`: keep the existing two tests (model now from `LLM_MODEL`); add: with `LLM_PROVIDER=anthropic-compatible`, `LLM_BASE_URL`, `LLM_MODEL=qwen3:8b`, the request has `model: 'qwen3:8b'`, keeps `tools`, `system`, `messages` and `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`, and has NO `thinking`, NO `fallbacks`, and no second options argument (no beta header) — even with `ANTHROPIC_FALLBACK=default`.

Run: `npm test -- config llm-sdk anthropic-llm-client` → FAIL.

- [ ] **Step 2: Implement**

- `config.ts`: the four `LLM_*` vars above plus a `superRefine` (or `refine`) requiring `LLM_BASE_URL` for `anthropic-compatible`.
- `llm-sdk.ts`: `createLlmSdk` and `isNativeAnthropic`.
- `AnthropicLlmClient`: `client ?? createLlmSdk(cfg)`; `model: cfg.LLM_MODEL`; add `thinking: { type: 'adaptive' }` only when `isNativeAnthropic(cfg)`; the fallback branch runs only when `isNativeAnthropic(cfg) && cfg.ANTHROPIC_FALLBACK !== 'off'`. Everything else unchanged (max_tokens 16000, tool_choice, verbatim return).
- `.env.example`: replace `ANTHROPIC_API_KEY=` / `ANTHROPIC_MODEL=claude-opus-5` with `LLM_PROVIDER=anthropic`, `LLM_BASE_URL=`, `LLM_MODEL=claude-opus-5`, `LLM_API_KEY=`, plus a comment showing the local option (`LLM_PROVIDER=anthropic-compatible`, `LLM_BASE_URL=http://localhost:11434` for Ollama ≥0.14, a tool-capable model such as `qwen3:8b`). Keep `ANTHROPIC_FALLBACK` if present.
- `README.md`: the `.env` comment says `LLM_*` instead of `ANTHROPIC_API_KEY`.
- grep the repo (excluding docs/superpowers, .claude, node_modules) for `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` and fix every code/test reference.

- [ ] **Step 3: Run**

Run: `npm test && npm run test:int && npm run lint && npm run typecheck` → all pass.

- [ ] **Step 4: Checkpoint.** Ask the user whether to commit.

---

# Phase F4 — Reply webhook (portfolio core)

### Task 15: `inbound_events` and `POST /webhooks/mail` (signature and dedupe, I3)

**Files:**
- Create: `src/inbound/inbound-event.repository.ts`, `src/inbound/webhook.controller.ts`, `src/inbound/inbound.module.ts`
- Modify: `prisma/schema.prisma`, `src/prisma/database.module.ts` (add `InboundEventRepository`), `src/app.module.ts` (import `InboundModule`)
- Test: `test/inbound/webhook.int-spec.ts`

**Interfaces:**
- Consumes: `MailProvider.parseInbound`, `InvalidSignatureError`, `InboundEvent`.
- Produces:
  - `InboundOutcome`, `InboundEventRow`;
  - `InboundEventRepository`:
    - `insertIfAbsent(e: InboundEvent): Promise<boolean>`
    - `claimNext(leaseSeconds: number, maxAttempts: number): Promise<InboundEventRow | null>`
    - `setOutcome(db: Db, eventId: string, outcome: InboundOutcome, extra?: { approvalRequestId?: string; classification?: string }): Promise<void>`
    - `recordError(eventId: string, error: string): Promise<void>`
  - `InboundModule`.

- [ ] **Step 1: Schema and migration**

Append to `prisma/schema.prisma`:

```prisma
model InboundEvent {
  providerEventId   String    @id @map("provider_event_id")
  receivedAt        DateTime  @default(now()) @map("received_at") @db.Timestamptz(3)
  payload           Json
  outcome           String?
  approvalRequestId String?   @map("approval_request_id") @db.Uuid
  classification    String?
  attempts          Int       @default(0)
  leaseUntil        DateTime? @map("lease_until") @db.Timestamptz(3)
  lastError         String?   @map("last_error")
  processedAt       DateTime? @map("processed_at") @db.Timestamptz(3)

  @@map("inbound_events")
}
```

Run: `npx prisma migrate dev --create-only --name inbound_events`, then append:

```sql
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_outcome_check" CHECK (outcome IS NULL OR outcome IN
  ('PROCESSED','CLARIFICATION_SENT','IGNORED_UNCLEAR','IGNORED_UNKNOWN_THREAD','IGNORED_SENDER','IGNORED_ALREADY_DECIDED'));
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_approval_fk"
  FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL;
CREATE INDEX "inbound_events_pending_idx" ON "inbound_events" ("received_at") WHERE outcome IS NULL;
```

Run: `npx prisma migrate dev && npx prisma generate`

- [ ] **Step 2: Write the failing HTTP tests**

`test/inbound/webhook.int-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '../../src/generated/prisma/client';
import { MAIL_PROVIDER } from '../../src/mail/mail-provider';
import { FakeMailProvider, replyPayload } from '../fakes/fake-mail';
import { createTestApp } from '../helpers/app';
import { newPrisma, truncateAll } from '../helpers/db';

describe('POST /webhooks/mail', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(MAIL_PROVIDER).useValue(new FakeMailProvider()));
    prisma = newPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(() => truncateAll(prisma));

  const post = (eventId: string, body: unknown, signed = true) => {
    const r = FakeMailProvider.signedRequest(eventId, body);
    const headers = signed ? r.headers : { ...r.headers, 'x-fake-signature': 'bad' };
    return request(app.getHttpServer()).post('/webhooks/mail').set(headers).send(JSON.stringify(body));
  };

  it('401 on an invalid signature and stores nothing', async () => {
    await post('evt_1', replyPayload({ threadId: 't', from: 'g@x.t', text: 'aprovo' }), false).expect(401);
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it('200 and not stored for other event types', async () => {
    await post('evt_2', { event_type: 'message.sent', message: {} }).expect(200, { received: true, stored: false });
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it('stores message.received with outcome NULL', async () => {
    await post('evt_3', replyPayload({ threadId: 'thr_1', from: 'Gestor <GESTOR@ACME.TEST>', text: 'pode aprovar' }))
      .expect(200, { received: true, stored: true });
    const row = await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_3' } });
    expect(row.outcome).toBeNull();
    expect(row.payload).toMatchObject({ threadId: 'thr_1', from: 'gestor@acme.test', text: 'pode aprovar' });
  });

  it('I3 — the same svix-id twice yields one row and 200 both times', async () => {
    const body = replyPayload({ threadId: 'thr_1', from: 'g@x.t', text: 'aprovo' });
    await post('evt_dup', body).expect(200, { received: true, stored: true });
    await post('evt_dup', body).expect(200, { received: true, stored: false });
    expect(await prisma.inboundEvent.count()).toBe(1);
  });

  it('stores a signed event without thread id (correlated later by subject token)', async () => {
    await post('evt_4', replyPayload({ threadId: null, from: 'g@x.t', text: 'aprovo', subject: 'RES: [mailgate #abcd2345] x' })).expect(200);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_4' } })).payload)
      .toMatchObject({ threadId: null, subject: 'RES: [mailgate #abcd2345] x' });
  });
});
```

Run: `npm run test:int -- webhook`
Expected: FAIL with 404 (route missing).

- [ ] **Step 3: Implement the repository, controller and module**

`src/inbound/inbound-event.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { InboundEvent } from '../mail/mail-provider';
import { Db } from '../prisma/db';
import { PrismaService } from '../prisma/prisma.service';

export type InboundOutcome =
  | 'PROCESSED' | 'CLARIFICATION_SENT' | 'IGNORED_UNCLEAR'
  | 'IGNORED_UNKNOWN_THREAD' | 'IGNORED_SENDER' | 'IGNORED_ALREADY_DECIDED';

export interface InboundEventRow {
  providerEventId: string;
  event: InboundEvent;
  attempts: number;
}

@Injectable()
export class InboundEventRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** I3: dedupe by provider event id. False when already stored. */
  async insertIfAbsent(e: InboundEvent): Promise<boolean> {
    const { count } = await this.prisma.inboundEvent.createMany({
      data: [{ providerEventId: e.eventId, payload: e as unknown as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async claimNext(leaseSeconds: number, maxAttempts: number): Promise<InboundEventRow | null> {
    const rows = await this.prisma.$queryRaw<{ provider_event_id: string; payload: InboundEvent; attempts: number }[]>`
      WITH picked AS (
        SELECT provider_event_id FROM inbound_events
        WHERE outcome IS NULL AND attempts < ${maxAttempts}::int
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY received_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      UPDATE inbound_events e
         SET lease_until = now() + make_interval(secs => ${leaseSeconds}::float8), attempts = e.attempts + 1
        FROM picked
       WHERE e.provider_event_id = picked.provider_event_id
      RETURNING e.provider_event_id, e.payload, e.attempts`;
    const row = rows[0];
    return row ? { providerEventId: row.provider_event_id, event: row.payload, attempts: row.attempts } : null;
  }

  async setOutcome(
    db: Db,
    eventId: string,
    outcome: InboundOutcome,
    extra: { approvalRequestId?: string; classification?: string } = {},
  ): Promise<void> {
    await db.inboundEvent.update({
      where: { providerEventId: eventId },
      data: { outcome, processedAt: new Date(), leaseUntil: null, lastError: null, ...extra },
    });
  }

  async recordError(eventId: string, error: string): Promise<void> {
    await this.prisma.inboundEvent.update({ where: { providerEventId: eventId }, data: { lastError: error } });
  }
}
```

`processedAt: new Date()` is informational only (display). No lease or expiry logic reads it, so convention 0003 does not apply.

`src/inbound/webhook.controller.ts`:

```ts
import { BadRequestException, Controller, Headers, HttpCode, Inject, Post, RawBodyRequest, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { InboundEvent, InvalidSignatureError, MAIL_PROVIDER, MailProvider } from '../mail/mail-provider';
import { InboundEventRepository } from './inbound-event.repository';

/** Stores events only; the worker's InboundProcessor decides (D014). */
@Controller('webhooks')
export class WebhookController {
  constructor(
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    private readonly events: InboundEventRepository,
  ) {}

  @Post('mail')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ): Promise<{ received: true; stored: boolean }> {
    if (!req.rawBody) throw new BadRequestException('raw body required');
    let event: InboundEvent;
    try {
      event = this.mail.parseInbound(req.rawBody, headers);
    } catch (e) {
      if (e instanceof InvalidSignatureError) throw new UnauthorizedException();
      throw e;
    }
    if (event.type !== 'message.received') return { received: true, stored: false };
    return { received: true, stored: await this.events.insertIfAbsent(event) };
  }
}
```

`src/inbound/inbound.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { WebhookController } from './webhook.controller';

@Module({ imports: [MailModule], controllers: [WebhookController] })
export class InboundModule {}
```

Add `InboundEventRepository` to `DatabaseModule` and `InboundModule` to `AppModule`.

- [ ] **Step 4: Run the tests**

Run: `npm run test:int -- webhook`
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask the user whether to commit.

---

### Task 16: Reply classifier (port, Claude implementation, fake) and correlation helpers

> **Amendment (D022, ADR 0007, added in w5).** The classifier builds its client with `createLlmSdk(cfg)` (Task 14b) instead of `new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY })`, and uses `cfg.LLM_MODEL`. When `isNativeAnthropic(cfg)`, keep `messages.parse` + `zodOutputFormat` as written below. Otherwise call `messages.create` with the same system prompt plus an instruction to answer only with a JSON object `{"decision": "APPROVED"|"REJECTED"|"UNCLEAR", "note": string}`, take the first text block, `JSON.parse` it inside try/catch, validate with the same zod `schema`; any failure returns `{ decision: 'UNCLEAR', note: 'classificação indisponível' }`. Add unit tests for both branches (valid JSON, invalid JSON → UNCLEAR, no `output_config` sent off Anthropic).

**Files:**
- Create: `src/inbound/reply-classifier.ts`, `src/inbound/claude-reply-classifier.ts`, `src/inbound/correlation.ts`, `test/fakes/fake-classifier.ts`
- Test: `src/inbound/claude-reply-classifier.spec.ts`, `src/inbound/correlation.spec.ts`

**Interfaces:**
- Consumes: `AppConfig`, `ANTHROPIC_SDK`, `SUBJECT_TOKEN_RE`.
- Produces:
  - `Classification { decision: 'APPROVED' | 'REJECTED' | 'UNCLEAR'; note: string }`;
  - `ReplyClassifier { classify(text: string): Promise<Classification> }`, `REPLY_CLASSIFIER`;
  - `ClaudeReplyClassifier`;
  - `extractSubjectToken(subject: string): string | null`;
  - `FakeClassifier` (test): keyword-based, with an optional `delayMs` and a call counter.

- [ ] **Step 1: Write the failing unit tests**

`src/inbound/correlation.spec.ts`:

```ts
import { extractSubjectToken } from './correlation';

describe('extractSubjectToken', () => {
  it.each([
    ['Re: [mailgate #abcd2345] Reembolso', 'abcd2345'],
    ['RES: [MAILGATE #ABCD2345] Reembolso', 'abcd2345'],
    ['Fwd: nada aqui', null],
    ['[mailgate #abc] curto', null],
  ])('%s -> %s', (s, t) => expect(extractSubjectToken(s)).toBe(t));
});
```

`src/inbound/claude-reply-classifier.spec.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config/config';
import { ClaudeReplyClassifier } from './claude-reply-classifier';

const cfg = loadConfig({ DATABASE_URL: 'postgresql://x' });

describe('ClaudeReplyClassifier', () => {
  it('returns the parsed output', async () => {
    const parse = jest.fn().mockResolvedValue({ parsed_output: { decision: 'APPROVED', note: 'pode aprovar' } });
    const c = new ClaudeReplyClassifier(cfg, { messages: { parse } } as unknown as Anthropic);
    expect(await c.classify('pode aprovar')).toEqual({ decision: 'APPROVED', note: 'pode aprovar' });
    expect(parse.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5', output_config: { effort: 'low' } });
    expect(JSON.stringify(parse.mock.calls[0][0].messages)).toContain('pode aprovar');
  });
  it('falls back to UNCLEAR when parsing fails (null parsed_output)', async () => {
    const parse = jest.fn().mockResolvedValue({ parsed_output: null });
    const c = new ClaudeReplyClassifier(cfg, { messages: { parse } } as unknown as Anthropic);
    expect((await c.classify('???')).decision).toBe('UNCLEAR');
  });
});
```

Run: `npm test -- inbound`
Expected: FAIL (modules not found).

- [ ] **Step 2: Implement**

`src/inbound/correlation.ts`:

```ts
import { SUBJECT_TOKEN_RE } from '../mail/templates';

export function extractSubjectToken(subject: string): string | null {
  const m = SUBJECT_TOKEN_RE.exec(subject);
  return m ? m[1].toLowerCase() : null;
}
```

`src/inbound/reply-classifier.ts`:

```ts
export interface Classification {
  decision: 'APPROVED' | 'REJECTED' | 'UNCLEAR';
  note: string;
}

export interface ReplyClassifier {
  classify(text: string): Promise<Classification>;
}

export const REPLY_CLASSIFIER = Symbol('REPLY_CLASSIFIER');
```

`src/inbound/claude-reply-classifier.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { ANTHROPIC_SDK } from '../agent/llm-client';
import { APP_CONFIG, AppConfig } from '../config/config';
import { Classification, ReplyClassifier } from './reply-classifier';

const schema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'UNCLEAR']),
  note: z.string(),
});

const SYSTEM = [
  'Você classifica a resposta de um gestor a um pedido de aprovação de reembolso.',
  'APPROVED: o gestor aprova claramente (ex.: "aprovo", "pode aprovar", "ok, pode pagar").',
  'REJECTED: o gestor recusa claramente (ex.: "recuso", "não aprovo", "recusa, falta nota fiscal").',
  'UNCLEAR: qualquer dúvida, pergunta, condição ou ambiguidade. Na dúvida, responda UNCLEAR.',
  'Ignore texto citado de e-mails anteriores. Em note, resuma o comentário do gestor em uma frase.',
].join('\n');

@Injectable()
export class ClaudeReplyClassifier implements ReplyClassifier {
  private readonly client: Anthropic;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Optional() @Inject(ANTHROPIC_SDK) client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  }

  async classify(text: string): Promise<Classification> {
    const res = await this.client.messages.parse({
      model: this.cfg.ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { effort: 'low', format: zodOutputFormat(schema) },
      messages: [{ role: 'user', content: `Resposta do gestor:\n"""\n${text}\n"""` }],
    });
    return res.parsed_output ?? { decision: 'UNCLEAR', note: 'classificação indisponível' };
  }
}
```

`test/fakes/fake-classifier.ts`:

```ts
import { Classification, ReplyClassifier } from '../../src/inbound/reply-classifier';

/** Deterministic keyword classifier for tests. */
export class FakeClassifier implements ReplyClassifier {
  calls = 0;
  constructor(private readonly delayMs = 0) {}

  async classify(text: string): Promise<Classification> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const t = text.toLowerCase();
    if (/\brecus|não aprovo/.test(t)) return { decision: 'REJECTED', note: text };
    if (/\baprov|pode pagar/.test(t)) return { decision: 'APPROVED', note: text };
    return { decision: 'UNCLEAR', note: text };
  }
}
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- inbound && npm run typecheck`
Expected: PASS and exit 0.

- [ ] **Step 4: Checkpoint.** Ask the user whether to commit.

---

### Task 17: InboundProcessor — correlation, sender (I6), decision transaction, end-to-end

**Files:**
- Create: `src/inbound/inbound.processor.ts`
- Modify: `src/approvals/approval.repository.ts` (add `findForCorrelation`), `src/inbound/inbound.module.ts` (providers and exports), `src/worker/worker.loop.ts` (drain inbound), `src/worker/worker.module.ts` (import `InboundModule`), `test/helpers/harness.ts` (add classifier, events, inbound)
- Test: `test/inbound/processor.int-spec.ts`

**Interfaces:**
- Consumes:
  - `InboundEventRepository`, `ApprovalRepository`, `RunRepository.resumeFromDecision`, `ReplyClassifier`, `MailProvider` (used in Task 18);
  - `extractSubjectToken`, `appendRunEvent`.
- Produces:
  - `ApprovalRepository.findForCorrelation(threadId: string | null, subjectToken: string | null): Promise<ApprovalRequest | null>`;
  - `InboundProcessor.processNext(): Promise<boolean>`, with constructor `(cfg, prisma, events, approvals, runs, classifier, mail)`;
  - the harness now also returns `{ classifier: FakeClassifier, events: InboundEventRepository, inbound: InboundProcessor, deliver(eventId, payload) }`;
  - `sentApproval(h, prisma)` is exported from `test/helpers/harness.ts`.

- [ ] **Step 1: Extend the harness and write the failing tests**

In `test/helpers/harness.ts`, add:

```ts
import { InboundEventRepository } from '../../src/inbound/inbound-event.repository';
import { InboundProcessor } from '../../src/inbound/inbound.processor';
import { toInboundEvent } from '../../src/mail/mail-provider';
import { FakeClassifier } from '../fakes/fake-classifier';
// extend opts with `classifierDelayMs?: number`; inside buildHarness:
  const classifier = new FakeClassifier(opts.classifierDelayMs ?? 0);
  const events = new InboundEventRepository(prisma);
  const inbound = new InboundProcessor(cfg, prisma, events, approvals, runs, classifier, mail);
  /** Simulates the webhook: normalize + insertIfAbsent. */
  const deliver = (eventId: string, payload: unknown) => events.insertIfAbsent(toInboundEvent(eventId, payload));
// add classifier, events, inbound, deliver to the returned object

// also add, at module level (imports: toolUse from '../fakes/scripted-llm', validInput from './fixtures'):
/** A R$ 840,00 run paused on request_approval with its approval already SENT (used by F4/F5 tests). */
export async function sentApproval(h: ReturnType<typeof buildHarness>, prisma: PrismaClient) {
  h.llm.push(toolUse('request_approval', { summary: 'Hotel 2 diárias', recommendation: 'APPROVE', rationale: 'dentro da média' }, 'toolu_ask'));
  const run = await h.runs.create(validInput({ amountCents: 84000 }));
  await h.worker.processNextRun();
  await h.outbox.dispatch();
  const approval = await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } });
  return { run, approval };
}
```

`test/inbound/processor.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { endTurn, toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('InboundProcessor', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('decides APPROVED from the approver (display name, uppercase) and resumes the run', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await h.deliver('evt_1', replyPayload({ threadId: approval.providerThreadId, from: 'Gestor <GESTOR@ACME.TEST>', text: 'pode aprovar' }));

    expect(await h.inbound.processNext()).toBe(true);

    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } }))
      .toMatchObject({ status: 'DECIDED', decision: 'APPROVED', decisionRawText: 'pode aprovar' });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_1' } }))
      .toMatchObject({ outcome: 'PROCESSED', approvalRequestId: approval.id, classification: 'APPROVED' });
    expect(await prisma.runEvent.count({ where: { runId: run.id, type: 'DECISION_RECEIVED' } })).toBe(1);
    expect(await h.inbound.processNext()).toBe(false);
  });

  it('I6 — a reply from another sender does not decide', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('evt_2', replyPayload({ threadId: approval.providerThreadId, from: 'intruso@evil.test', text: 'aprovo' }));
    await h.inbound.processNext();
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('SENT');
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_2' } })).outcome).toBe('IGNORED_SENDER');
    expect(h.classifier.calls).toBe(0);
  });

  it('ignores an unknown thread without a subject token', async () => {
    const h = buildHarness(prisma);
    await sentApproval(h, prisma);
    await h.deliver('evt_3', replyPayload({ threadId: 'thr_unknown', from: 'gestor@acme.test', text: 'aprovo' }));
    await h.inbound.processNext();
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_3' } })).outcome).toBe('IGNORED_UNKNOWN_THREAD');
  });

  it('correlates by subject token when the thread id is missing', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('evt_4', replyPayload({
      threadId: null, from: 'gestor@acme.test', text: 'recuso, falta nota fiscal',
      subject: `RES: [MAILGATE #${approval.subjectToken.toUpperCase()}] Reembolso`,
    }));
    await h.inbound.processNext();
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } }))
      .toMatchObject({ status: 'DECIDED', decision: 'REJECTED' });
  });

  it('ignores replies to an already decided request without calling the classifier again', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('evt_5', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'aprovo' }));
    await h.deliver('evt_6', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'recuso' }));
    await h.inbound.processNext();
    await h.inbound.processNext();
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_6' } })).outcome).toBe('IGNORED_ALREADY_DECIDED');
    expect(h.classifier.calls).toBe(1);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).decision).toBe('APPROVED');
  });

  it('I3 — the same event delivered twice produces one decision', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    const payload = replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'aprovo' });
    expect(await h.deliver('evt_same', payload)).toBe(true);
    expect(await h.deliver('evt_same', payload)).toBe(false);
    while (await h.inbound.processNext()) { /* drain */ }
    expect(await prisma.inboundEvent.count()).toBe(1);
    expect(await prisma.runEvent.count({ where: { runId: run.id, type: 'DECISION_RECEIVED' } })).toBe(1);
  });

  it('F4 acceptance (in-process) — run > R$ 500 → e-mail → "pode aprovar" → COMPLETED with one action', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await h.deliver('evt_e2e', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'pode aprovar' }));
    await h.inbound.processNext();
    h.llm.push(toolUse('record_decision', { decision: 'APPROVED', reason: 'aprovado pelo gestor' }), endTurn());
    await h.worker.processNextRun();
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
    expect(await prisma.action.count({ where: { runId: run.id } })).toBe(1);
  });
});
```

Run: `npm run test:int -- processor`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement correlation lookup and the processor**

Add to `ApprovalRepository`:

```ts
  async findForCorrelation(threadId: string | null, subjectToken: string | null): Promise<ApprovalRequest | null> {
    if (threadId) {
      const byThread = await this.prisma.approvalRequest.findFirst({ where: { providerThreadId: threadId } });
      if (byThread) return toApproval(byThread);
    }
    if (subjectToken) {
      const byToken = await this.prisma.approvalRequest.findUnique({ where: { subjectToken } });
      if (byToken) return toApproval(byToken);
    }
    return null;
  }
```

`src/inbound/inbound.processor.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApprovalRepository, ApprovalRequest } from '../approvals/approval.repository';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaClient } from '../generated/prisma/client';
import { InboundEvent, MAIL_PROVIDER, MailProvider } from '../mail/mail-provider';
import { PrismaService } from '../prisma/prisma.service';
import { appendRunEvent } from '../runs/run-events';
import { RunRepository } from '../runs/run.repository';
import { extractSubjectToken } from './correlation';
import { InboundEventRepository } from './inbound-event.repository';
import { Classification, REPLY_CLASSIFIER, ReplyClassifier } from './reply-classifier';

@Injectable()
export class InboundProcessor {
  private readonly logger = new Logger(InboundProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly events: InboundEventRepository,
    private readonly approvals: ApprovalRepository,
    private readonly runs: RunRepository,
    @Inject(REPLY_CLASSIFIER) private readonly classifier: ReplyClassifier,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  /** Claims and handles one pending inbound event. False when none is pending. */
  async processNext(): Promise<boolean> {
    const row = await this.events.claimNext(this.cfg.LEASE_SECONDS, this.cfg.MAX_ATTEMPTS);
    if (!row) return false;
    try {
      await this.handle(row.providerEventId, row.event);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`inbound ${row.providerEventId} failed (attempt ${row.attempts}): ${message}`);
      await this.events.recordError(row.providerEventId, message);
    }
    return true;
  }

  private async handle(eventId: string, event: InboundEvent): Promise<void> {
    const approval = await this.approvals.findForCorrelation(event.threadId, extractSubjectToken(event.subject));
    if (!approval) return this.events.setOutcome(this.prisma, eventId, 'IGNORED_UNKNOWN_THREAD');

    const link = { approvalRequestId: approval.id };
    if (event.from.toLowerCase() !== approval.approverEmail) {
      return this.events.setOutcome(this.prisma, eventId, 'IGNORED_SENDER', link); // I6
    }
    // cheap pre-check without lock; the authoritative check is under FOR UPDATE below
    if (approval.status !== 'SENT') return this.events.setOutcome(this.prisma, eventId, 'IGNORED_ALREADY_DECIDED', link);

    const c = await this.classifier.classify(event.text); // outside any transaction (convention 0004)
    if (c.decision === 'UNCLEAR') return this.handleUnclear(eventId, event, approval, c);
    await this.decide(eventId, event, approval, c);
  }

  /** I2: lock the approval row, check SENT, decide, resume the run, all in one transaction. */
  private async decide(eventId: string, event: InboundEvent, approval: ApprovalRequest, c: Classification): Promise<void> {
    const extra = { approvalRequestId: approval.id, classification: c.decision };
    await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM approval_requests WHERE id = ${approval.id}::uuid FOR UPDATE`;
      if (locked?.status !== 'SENT') {
        await this.events.setOutcome(tx, eventId, 'IGNORED_ALREADY_DECIDED', extra);
        return;
      }
      await tx.approvalRequest.update({
        where: { id: approval.id },
        data: { status: 'DECIDED', decision: c.decision, decisionNote: c.note, decisionRawText: event.text },
      });
      if (!(await this.runs.resumeFromDecision(tx, approval.runId))) {
        throw new Error(`run ${approval.runId} is not WAITING_APPROVAL`);
      }
      await appendRunEvent(tx, approval.runId, 'DECISION_RECEIVED', { approvalId: approval.id, decision: c.decision, from: event.from });
      await this.events.setOutcome(tx, eventId, 'PROCESSED', extra);
    });
  }

  /** Task 18 adds the clarification e-mail; until then UNCLEAR is only recorded. */
  private async handleUnclear(eventId: string, _event: InboundEvent, approval: ApprovalRequest, c: Classification): Promise<void> {
    await this.events.setOutcome(this.prisma, eventId, 'IGNORED_UNCLEAR', { approvalRequestId: approval.id, classification: c.decision });
  }
}
```

In `InboundModule`, add `providers: [{ provide: REPLY_CLASSIFIER, useClass: ClaudeReplyClassifier }, InboundProcessor]` and `exports: [InboundProcessor]`.

In `WorkerModule`, import `InboundModule`. In `WorkerLoop`, inject `InboundProcessor` and drain it after the outbox:

```ts
      for (let i = 0; i < 20 && (await this.inbound.processNext()); i++) {
        /* keep draining */
      }
```

- [ ] **Step 3: Run the tests**

Run: `npm run test:int`
Expected: PASS (all suites).

- [ ] **Step 4: Checkpoint.** Ask the user whether to commit.

---

### Task 18: UNCLEAR clarification, I2 concurrency, manual E2E script

**Files:**
- Modify: `src/inbound/inbound.processor.ts` (`handleUnclear`)
- Create: `docs/e2e.md`
- Test: `test/inbound/unclear.int-spec.ts`, `test/inbound/decision.concurrency.int-spec.ts`

**Interfaces:**
- Consumes: `MailProvider.reply`, `renderClarificationEmail`.
- Produces: at most one clarification per approval (outcome `CLARIFICATION_SENT` and then `IGNORED_UNCLEAR`), and the I2 proof.

- [ ] **Step 1: Write the failing tests**

`test/inbound/unclear.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('UNCLEAR replies', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('sends exactly one clarification in-thread, then ignores further UNCLEAR replies', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('evt_u1', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'hmm, qual projeto?', messageId: '<in-1@fake>' }));
    await h.deliver('evt_u2', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'talvez', messageId: '<in-2@fake>' }));
    await h.inbound.processNext();
    await h.inbound.processNext();

    expect(h.mail.replies).toHaveLength(1);
    expect(h.mail.replies[0]).toMatchObject({ messageId: '<in-1@fake>', idempotencyKey: `clarify-${approval.id}` });
    expect(h.mail.replies[0].text).toContain('Responda apenas APROVO ou RECUSO');
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } }))).toMatchObject({ status: 'SENT', clarificationSent: true });
    const outcomes = await prisma.inboundEvent.findMany({ orderBy: { receivedAt: 'asc' } });
    expect(outcomes.map((o) => o.outcome)).toEqual(['CLARIFICATION_SENT', 'IGNORED_UNCLEAR']);
  });

  it('keeps the event pending when the clarification send fails, and retries after the lease', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    h.mail.failNextReplies = 1;
    await h.deliver('evt_u3', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'hmm' }));
    await h.inbound.processNext();
    expect(await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_u3' } }))
      .toMatchObject({ outcome: null, lastError: 'fake: provider unavailable' });
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).clarificationSent).toBe(false);

    await prisma.$executeRaw`UPDATE inbound_events SET lease_until = now() - interval '1 second'`;
    await h.inbound.processNext();
    expect(h.mail.replies).toHaveLength(1);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_u3' } })).outcome).toBe('CLARIFICATION_SENT');
  });
});
```

`test/inbound/decision.concurrency.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('I2 — an approval request receives at most one decision', () => {
  let seed: PrismaClient;
  const clients: PrismaClient[] = [];
  beforeAll(() => {
    seed = newPrisma();
  });
  afterAll(async () => {
    await Promise.all([seed, ...clients].map((c) => c.$disconnect()));
  });
  beforeEach(() => truncateAll(seed));

  it('two different replies processed in parallel produce exactly one decision', async () => {
    const h = buildHarness(seed);
    const { run, approval } = await sentApproval(h, seed);
    await h.deliver('evt_a', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'aprovo' }));
    await h.deliver('evt_r', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'recuso' }));

    const processors = [0, 1].map(() => {
      const c = newPrisma(3);
      clients.push(c);
      return buildHarness(c, { classifierDelayMs: 30 }).inbound; // both pass the pre-check, then race on FOR UPDATE
    });
    await Promise.all(processors.map((p) => p.processNext()));

    const outcomes = (await seed.inboundEvent.findMany()).map((e) => e.outcome).sort();
    expect(outcomes).toEqual(['IGNORED_ALREADY_DECIDED', 'PROCESSED']);
    expect((await seed.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('DECIDED');
    expect(await seed.runEvent.count({ where: { runId: run.id, type: 'DECISION_RECEIVED' } })).toBe(1);
    expect((await seed.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('PENDING');
  });
});
```

Run: `npm run test:int -- unclear`
Expected: FAIL, because no reply was sent.

- [ ] **Step 2: Implement `handleUnclear`**

Add `import { renderClarificationEmail } from '../mail/templates';` to `inbound.processor.ts` and replace the Task 17 `handleUnclear`:

```ts
  /** At most one clarification per approval: send first (idempotent key), then flip the flag. */
  private async handleUnclear(eventId: string, event: InboundEvent, approval: ApprovalRequest, c: Classification): Promise<void> {
    const extra = { approvalRequestId: approval.id, classification: c.decision };
    if (approval.clarificationSent) return this.events.setOutcome(this.prisma, eventId, 'IGNORED_UNCLEAR', extra);

    const body = renderClarificationEmail();
    await this.mail.reply({ messageId: event.messageId, ...body, idempotencyKey: `clarify-${approval.id}` });
    const { count } = await this.prisma.approvalRequest.updateMany({
      where: { id: approval.id, clarificationSent: false },
      data: { clarificationSent: true },
    });
    await this.events.setOutcome(this.prisma, eventId, count === 1 ? 'CLARIFICATION_SENT' : 'IGNORED_UNCLEAR', extra);
  }
```

- [ ] **Step 3: Run the tests, then the stress suite**

Run: `npm run test:int`
Expected: PASS (all suites).

Run: `npm run test:stress`
Expected: `stress: 20/20 green`. It now includes `decision.concurrency`.

- [ ] **Step 4: Write `docs/e2e.md`**

````markdown
# Manual end-to-end (real AgentMail + Claude)

Not part of CI. Proves F3/F4 acceptance with real providers.

## Spike (F3)
Record here the output of `npx ts-node scripts/agentmail-spike.ts` (idempotent: true/false, date, SDK version).

## Setup
1. `.env`: `ANTHROPIC_API_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET` (from the webhook created in AgentMail).
2. `docker compose up -d postgres && npx prisma migrate deploy && npm run start:dev`
3. Expose the API: `cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`).
4. In AgentMail, point a webhook for `message.received` at `<tunnel-url>/webhooks/mail`.

## Flow
1. `curl -s localhost:3000/runs -H 'content-type: application/json' -d '{"description":"Hotel SP","amountCents":84000,"category":"TRAVEL","requesterEmail":"ana@acme.test","approverEmail":"<your inbox>"}'`
2. `GET /runs/<id>` → `WAITING_APPROVAL`, approval `SENT`.
3. Reply to the e-mail from `<your inbox>` with "pode aprovar".
4. `GET /runs/<id>` → `COMPLETED`, `action.type = REIMBURSEMENT_APPROVED`, timeline contains APPROVAL_SENT → DECISION_RECEIVED → RESUMED → ACTION_RECORDED → COMPLETED.

## Result
Date, outcome, anything unexpected (e.g. `extracted_text` missing in webhook, thread id behavior).
````

- [ ] **Step 5: F4 acceptance (manual).** Ask the user to run `docs/e2e.md` with real providers, or to authorize you to drive it. Record the result in `docs/e2e.md`.

- [ ] **Step 6: Checkpoint.** Ask the user whether to commit.

---

# Phase F5 — Expiry

### Task 19: Expiry job and the decision × expiry race

**Files:**
- Create: `src/expiry/expiry.service.ts`, `src/expiry/expiry.module.ts`
- Modify: `src/runs/run.repository.ts` (add `expireWaiting`), `src/worker/worker.loop.ts` (throttled expiry), `src/worker/worker.module.ts` (import `ExpiryModule`), `test/helpers/harness.ts` (add expiry)
- Test: `test/expiry/expiry.int-spec.ts`, `test/expiry/expiry.concurrency.int-spec.ts`

**Interfaces:**
- Consumes: `RunRepository`, `appendRunEvent`.
- Produces:
  - `RunRepository.expireWaiting(db: Db, runId: string): Promise<boolean>`;
  - `ExpiryService.expireDue(): Promise<number>`;
  - the harness returns `expiry`.

- [ ] **Step 1: Write the failing tests**

In `test/helpers/harness.ts`, add `import { ExpiryService } from '../../src/expiry/expiry.service';`, then `const expiry = new ExpiryService(prisma, runs);`, and return it.

`test/expiry/expiry.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness, sentApproval } from '../helpers/harness';

const pastDue = (prisma: PrismaClient, id: string) =>
  prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ${id}::uuid`;

describe('ExpiryService', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('expires a SENT request past expires_at and its run; the run never acts', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await pastDue(prisma, approval.id);

    expect(await h.expiry.expireDue()).toBe(1);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('EXPIRED');
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('EXPIRED');
    expect(await prisma.runEvent.count({ where: { runId: run.id, type: 'EXPIRED' } })).toBe(1);
    expect(await h.runs.claim(60)).toBeNull();
    expect(await prisma.action.count({ where: { runId: run.id } })).toBe(0);
  });

  it('expires a CREATED request whose send never succeeded', async () => {
    const h = buildHarness(prisma);
    h.llm.push(toolUse('request_approval', { summary: 's', recommendation: 'APPROVE', rationale: 'r' }));
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    const a = await prisma.approvalRequest.findFirstOrThrow({ where: { runId: run.id } });
    await pastDue(prisma, a.id);
    await h.expiry.expireDue();
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('EXPIRED');
  });

  it('leaves requests that are not yet due', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    expect(await h.expiry.expireDue()).toBe(0);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('SENT');
  });

  it('ignores a reply arriving after expiry', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await pastDue(prisma, approval.id);
    await h.expiry.expireDue();
    await h.deliver('evt_late', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'aprovo' }));
    await h.inbound.processNext();
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_late' } })).outcome).toBe('IGNORED_ALREADY_DECIDED');
  });
});
```

`test/expiry/expiry.concurrency.int-spec.ts`:

```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('decision × expiry race — exactly one wins', () => {
  let seed: PrismaClient;
  const clients: PrismaClient[] = [];
  beforeAll(() => {
    seed = newPrisma();
  });
  afterAll(async () => {
    await Promise.all([seed, ...clients].map((c) => c.$disconnect()));
  });
  beforeEach(() => truncateAll(seed));

  it.each([0, 5, 20])('classifier delay %ims', async (delay) => {
    const h = buildHarness(seed);
    const { run, approval } = await sentApproval(h, seed);
    await h.deliver('evt_race', replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'aprovo' }));
    await seed.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = ${approval.id}::uuid`;

    const [c1, c2] = [newPrisma(3), newPrisma(3)];
    clients.push(c1, c2);
    const decider = buildHarness(c1, { classifierDelayMs: delay }).inbound;
    const expirer = buildHarness(c2).expiry;
    await Promise.all([decider.processNext(), expirer.expireDue()]);
    await buildHarness(seed).expiry.expireDue(); // a SKIP LOCKED pass may have skipped the row; the next tick picks it up

    const a = await seed.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    const r = await seed.run.findUniqueOrThrow({ where: { id: run.id } });
    const decided = a.status === 'DECIDED' && r.status === 'PENDING';
    const expired = a.status === 'EXPIRED' && r.status === 'EXPIRED';
    expect(decided !== expired).toBe(true);
    expect(await seed.runEvent.count({ where: { runId: run.id, type: { in: ['DECISION_RECEIVED', 'EXPIRED'] } } })).toBe(1);
  });
});
```

Run: `npm run test:int -- expiry`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement**

Add to `RunRepository`:

```ts
  async expireWaiting(db: Db, runId: string): Promise<boolean> {
    const { count } = await db.run.updateMany({
      where: { id: runId, status: 'WAITING_APPROVAL' },
      data: { status: 'EXPIRED', leaseToken: null, leaseUntil: null },
    });
    return count === 1;
  }
```

`src/expiry/expiry.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { appendRunEvent } from '../runs/run-events';
import { RunRepository } from '../runs/run.repository';

const BATCH = 50;

@Injectable()
export class ExpiryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly runs: RunRepository,
  ) {}

  /** Expires CREATED/SENT requests past expires_at and their runs, atomically (D013). */
  async expireDue(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<{ id: string; run_id: string }[]>`
        SELECT id, run_id FROM approval_requests
         WHERE status IN ('CREATED','SENT') AND expires_at < now()
         ORDER BY expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT ${BATCH}::int`;
      for (const a of due) {
        await tx.approvalRequest.updateMany({
          where: { id: a.id, status: { in: ['CREATED', 'SENT'] } },
          data: { status: 'EXPIRED' },
        });
        if (await this.runs.expireWaiting(tx, a.run_id)) {
          await appendRunEvent(tx, a.run_id, 'EXPIRED', { approvalId: a.id });
        }
      }
      return due.length;
    });
  }
}
```

`src/expiry/expiry.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ExpiryService } from './expiry.service';

@Module({ providers: [ExpiryService], exports: [ExpiryService] })
export class ExpiryModule {}
```

In `WorkerModule`, import `ExpiryModule`. In `WorkerLoop`, inject `ExpiryService`, add the field `private lastExpiryAt = 0;`, and at the end of `tick()`'s `try`:

```ts
      if (Date.now() - this.lastExpiryAt >= this.cfg.EXPIRY_INTERVAL_MS) {
        this.lastExpiryAt = Date.now(); // scheduling only; expiry itself compares with DB now() (convention 0003)
        await this.expiry.expireDue();
      }
```

- [ ] **Step 3: Run everything**

Run: `npm test && npm run test:int && npm run lint && npm run typecheck && npm run test:stress`
Expected: all green, and `stress: 20/20 green`.

- [ ] **Step 4: Final compose smoke test**

Run: `docker compose down -v && docker compose up -d --build && sleep 5 && curl -s localhost:3000/health && docker compose down`
Expected: `{"status":"ok"}`.

- [ ] **Step 5: Checkpoint.** F0–F5 are complete. Ask the user whether to commit, and suggest `/sdd close`.

---

## Invariant → test map (for the F6 README "Guarantees")

| Invariant | Test |
|---|---|
| I1 | `test/agent/agent-decision.int-spec.ts` › "I1 — re-executing record_decision after a crash…" |
| I2 | `test/inbound/decision.concurrency.int-spec.ts`, `test/expiry/expiry.concurrency.int-spec.ts` |
| I3 | `test/inbound/webhook.int-spec.ts` › "I3 — same svix-id twice", `test/inbound/processor.int-spec.ts` › "I3 — same event delivered twice" |
| I4 | `test/worker/claim.concurrency.int-spec.ts`, `test/runs/run-lease.int-spec.ts` › zombie token |
| I5 | `test/agent/agent-pause.int-spec.ts` › "I5 — request_approval parks the run…" |
| I6 | `test/inbound/processor.int-spec.ts` › "I6 — a reply from another sender…" |
