# mailgate F6 + hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close backlog items 0001–0010 and publish mailgate. The work covers:
- hardening of shutdown, expiry, outbox and inbound;
- a late-reply e-mail;
- a public timeline page;
- an OpenAI-compatible LLM adapter;
- a DEMO mode that records the README GIFs;
- the MIT license, the README and the deploy guide.

**Architecture:** Same single NestJS process as F0–F5: API plus worker loops over a Postgres queue with lease and fencing. The changes are local:
- the approval and inbound state machines get stricter guards (DB clock, row locks, `outcome IS NULL`);
- the worker drains before Prisma disconnects;
- new ports are chosen by `useFactory` on `APP_CONFIG`: the LLM client, the classifier and the mail provider.

**Tech Stack:** Node 22, NestJS 11, TypeScript strict (CJS), Prisma 7.10 + `@prisma/adapter-pg`, PostgreSQL 16, `@anthropic-ai/sdk` 0.128.0, `openai` (exact version, new), `agentmail` 0.5.27, `svix` 2.5.0, `zod` 4, Jest + ts-jest + Testcontainers + supertest. For the demo: VHS, Playwright, ffmpeg and gifski.

**Spec:**
- `/Users/roberto/Documents/mailgate/.claude/sdd/f6-hardening/CONTRACT.md` (D001–D015)
- `/Users/roberto/Documents/mailgate/docs/superpowers/specs/f6-hardening/design.md`
- Read also:
  - `.claude/sdd/f6-hardening/RESEARCH.md`;
  - `docs/01-specs/0005`, `0006`;
  - `docs/02-adr/0008`–`0013`;
  - `docs/03-pdr/0005`, `0006`;
  - `docs/04-conventions/README.md` and `docs/05-lessons/README.md` **before writing code**.

## Global Constraints

- Node 22 LTS everywhere. Prisma stays `7.10.0` exact; never install Prisma 8.
- Status and outcome columns are `text` + `CHECK`, never Prisma enums.
- Lease, backoff, expiry and "now" comparisons use the DB `now()`, never `new Date()` (convention 0003).
- No LLM or e-mail call inside `$transaction` (convention 0004).
- No `create` + catch P2002 inside a transaction (convention 0002).
- Every worker write to `runs` filters by `id` + `lease_token` + `status`; 0 rows means `LeaseLostError` (convention 0001).
- Claude history stays append-only: `response.content` is stored verbatim (convention 0005).
- Idempotency keys:
  - `approval-<approvalId>` for the approval e-mail;
  - `clarify-<approvalId>` for the clarification;
  - **`late-<approvalId>`** for the late reply.
- E-mail copy and the timeline page are in pt-BR. `docs/**` is in English.
- Any `package-lock.json` change is regenerated inside `node:22-alpine` (lesson 0002):
  ```bash
  docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only
  ```
  Then check that `grep -c '"node_modules/@emnapi' package-lock.json` did not drop.
- CI tests never touch the network, except Docker for Testcontainers. LLM, mail and classifier are always faked.
- **Git:**
  - never commit without the user asking. Every "Checkpoint" step means stop, report and ask whether to commit;
  - commit messages have no Co-Authored-By trailer.
- New env defaults:
  - `SHUTDOWN_GRACE_MS=8000`, which must be `< 15000`;
  - `LLM_STRICT_OUTPUT=false`;
  - `DEMO=false`, which is rejected when `NODE_ENV=production`.
- Backoff formula for outbox sends: `next_send_at = now() + least(30s · 2^(send_attempts_before), 1h)`.
- Timeline masking: the approver e-mail shows as `g***@domain.com`, and errors show only as `transitório` or `permanente`.
- Commands:
  - `npm run lint`
  - `npm run typecheck`
  - `npm test` (unit, `src/**/*.spec.ts`)
  - `npm run test:int` (Testcontainers, `test/**/*.int-spec.ts`, needs Docker)
  - `npm run test:stress`

## Review Focus

1. **A reply that arrives after `expires_at` but before the expiry job ran.** The approval is still `SENT` but past the deadline. It must be `IGNORED_EXPIRED` with a late reply, and never decide. Tests in Task 6 and Task 10.
2. **The approver answers twice after the decision.** Exactly one late-reply e-mail is sent. Test in Task 10.
3. **A run description with `<script>`, quotes and apostrophes** renders as inert text on the timeline page. Test in Task 2 (renderer) and Task 11 (HTTP).
4. **SIGTERM while the LLM call hangs past the grace period.** The run returns to `PENDING` with its attempt given back, and never stays `RUNNING`. Test in Task 4.
5. **The model returns two `tool_calls` in one OpenAI response.** Only the first becomes a `tool_use` block, so the runner never leaves an unanswered call. Test in Task 12.

---

## Window w1 — screens (design first; closes only with explicit visual approval)

### Task 1: Shared HTML helpers + late-reply e-mail template + mock

**Files:**
- Create: `src/shared/html.ts`, `src/shared/html.spec.ts`
- Modify: `src/mail/templates.ts` (import tokens and `escapeHtml` from shared; add `renderLateReplyEmail`), `src/mail/templates.spec.ts`, `scripts/render-mocks.ts`
- Create (generated): `docs/mocks/late-reply-decided.html`, `docs/mocks/late-reply-decided.txt`, `docs/mocks/late-reply-expired.html`, `docs/mocks/late-reply-expired.txt`

**Interfaces:**
- Produces:
  - `escapeHtml(s: string): string`, which also escapes `'` → `&#39;`;
  - tokens `FONT`, `INK`, `MUTED`, `ACCENT`, `ACCENT_TINT`, `RULE`;
  - `maskEmail(email: string): string`;
  - `renderLateReplyEmail(d: LateReplyData): { text: string; html: string }`, with `LateReplyData = { state: 'APPROVED' | 'REJECTED' | 'EXPIRED'; at: Date; note: string | null }`.

- [ ] **Step 1: Write failing tests**

`src/shared/html.spec.ts`:
```ts
import { escapeHtml, maskEmail } from './html';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('gestor@acme.test')).toBe('g***@acme.test');
  });
  it('masks a one-letter local part', () => {
    expect(maskEmail('g@acme.test')).toBe('g***@acme.test');
  });
  it('returns *** for something that is not an address', () => {
    expect(maskEmail('nope')).toBe('***');
  });
});
```

Append to `src/mail/templates.spec.ts`:
```ts
import { renderLateReplyEmail } from './templates';

describe('renderLateReplyEmail', () => {
  const at = new Date('2026-09-24T17:30:00Z'); // 14:30 in Brasília
  it('tells the approver the request was already approved, with date and note', () => {
    const r = renderLateReplyEmail({ state: 'APPROVED', at, note: 'ok, pode pagar' });
    expect(r.text).toContain('Este pedido já foi APROVADO em 24/09/2026');
    expect(r.text).toContain('Sua resposta não alterou a decisão.');
    expect(r.text).toContain('ok, pode pagar');
    expect(r.html).toContain('APROVADO');
  });
  it('tells the approver the request expired', () => {
    const r = renderLateReplyEmail({ state: 'EXPIRED', at, note: null });
    expect(r.text).toContain('Este pedido expirou em 24/09/2026');
    expect(r.text).toContain('Sua resposta não foi registrada.');
  });
  it('escapes the note in HTML', () => {
    const r = renderLateReplyEmail({ state: 'REJECTED', at, note: `<b>'x'</b>` });
    expect(r.html).toContain('&lt;b&gt;&#39;x&#39;&lt;/b&gt;');
    expect(r.html).not.toContain('<b>');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest -c jest.config.js src/shared/html.spec.ts src/mail/templates.spec.ts`
Expected: FAIL. `Cannot find module './html'` and `renderLateReplyEmail is not a function`.

- [ ] **Step 3: Implement**

`src/shared/html.ts`:
```ts
// E-mail-safe design tokens (pdr 0004), shared by the e-mails and the timeline page.
export const FONT =
  "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const INK = '#1a1a1a';
export const MUTED = '#55606e';
export const ACCENT = '#1d4ed8';
export const ACCENT_TINT = '#eef2ff';
export const RULE = '#e5e7eb';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "gestor@acme.test" -> "g***@acme.test" (pdr 0006). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
```

In `src/mail/templates.ts`:
- delete the local `FONT`, `INK`, `MUTED`, `ACCENT`, `ACCENT_TINT` and `RULE` constants and the local `escapeHtml`;
- add `import { ACCENT, ACCENT_TINT, FONT, INK, MUTED, RULE, escapeHtml } from '../shared/html';`;
- then append:
```ts
export interface LateReplyData {
  state: 'APPROVED' | 'REJECTED' | 'EXPIRED';
  at: Date;
  note: string | null;
}

const LATE_LABEL = { APPROVED: 'APROVADO', REJECTED: 'RECUSADO' } as const;

export function renderLateReplyEmail(d: LateReplyData): {
  text: string;
  html: string;
} {
  const when = formatDeadline(d.at);
  const lines =
    d.state === 'EXPIRED'
      ? [
          `Este pedido expirou em ${when} (horário de Brasília), sem resposta a tempo.`,
          'Sua resposta não foi registrada. Se ainda for preciso, peça ao solicitante um novo pedido.',
        ]
      : [
          `Este pedido já foi ${LATE_LABEL[d.state]} em ${when} (horário de Brasília).`,
          'Sua resposta não alterou a decisão.',
        ];
  const note = d.note ? `Comentário registrado: ${d.note}` : null;
  const text = [...lines, ...(note ? ['', note] : []), '', '— mailgate'].join('\n');
  const html = shell(
    [
      preheader(lines[0]),
      `<tr><td><strong>${escapeHtml(lines[0])}</strong><br>${escapeHtml(lines[1])}</td></tr>`,
      note
        ? `<tr><td style="padding-top:12px;font-size:13px;color:${MUTED}">${escapeHtml(note)}</td></tr>`
        : '',
      footerRow(),
    ].join(''),
  );
  return { text, html };
}
```

In `scripts/render-mocks.ts`, add after the clarification mock:
```ts
const decided = renderLateReplyEmail({
  state: 'APPROVED',
  at: new Date('2026-09-24T17:30:00Z'),
  note: 'Pode aprovar, reunião confirmada.',
});
writeFileSync(join(out, 'late-reply-decided.txt'), `${decided.text}\n`);
writeFileSync(
  join(out, 'late-reply-decided.html'),
  page('Re: [mailgate #k7q2m4xa] …', decided.html),
);
const expired = renderLateReplyEmail({
  state: 'EXPIRED',
  at: new Date('2026-09-25T17:30:00Z'),
  note: null,
});
writeFileSync(join(out, 'late-reply-expired.txt'), `${expired.text}\n`);
writeFileSync(
  join(out, 'late-reply-expired.html'),
  page('Re: [mailgate #k7q2m4xa] …', expired.html),
);
```
(and add `renderLateReplyEmail` to its import).

- [ ] **Step 4: Run tests, lint and mocks**

Run:
```bash
npx jest -c jest.config.js src/shared src/mail
npm run lint
npm run typecheck
npm run render:mocks
```
Expected: all PASS. `docs/mocks/late-reply-*.{html,txt}` are written. The existing approval and clarification tests stay green; apostrophes now appear as `&#39;` in HTML only.

- [ ] **Step 5: Checkpoint.** Report and ask the user whether to commit (`feat(mail): late-reply template and shared html helpers`).

### Task 2: Timeline page renderer (pure) + mock

**Files:**
- Create: `src/runs/timeline-page.ts`, `src/runs/timeline-page.spec.ts`
- Modify: `src/runs/run-events.ts` (add `'RELEASED'` to `RunEventType`, used by Task 4), `scripts/render-mocks.ts`
- Create (generated): `docs/mocks/timeline-waiting.html`, `docs/mocks/timeline-completed.html`

**Interfaces:**
- Consumes: `RunView` from `src/runs/runs.service.ts` (unchanged), plus `escapeHtml`, `maskEmail` and the tokens from Task 1.
- Produces: `renderTimelinePage(v: RunView): string` and `TERMINAL_STATUSES: ReadonlySet<string>`.

- [ ] **Step 1: Write failing tests** in `src/runs/timeline-page.spec.ts`:
```ts
import { RunView } from './runs.service';
import { renderTimelinePage } from './timeline-page';

const base = (patch: Partial<RunView> = {}): RunView => ({
  id: '11111111-1111-4111-8111-111111111111',
  status: 'WAITING_APPROVAL',
  input: {
    description: `Hotel <script>alert('x')</script> "SP"`,
    amountCents: 84000,
    category: 'TRAVEL',
    requesterEmail: 'ana@acme.test',
    approverEmail: 'gestor@acme.test',
  },
  attempts: 1,
  lastError: 'ECONNRESET upstream secret-host:5432',
  approval: {
    status: 'SENT',
    decision: null,
    note: null,
    expiresAt: new Date('2026-09-25T17:30:00Z'),
  },
  action: null,
  timeline: [
    { at: new Date('2026-09-23T12:00:00Z'), type: 'CREATED', data: {} },
    {
      at: new Date('2026-09-23T12:00:05Z'),
      type: 'DECISION_RECEIVED',
      data: { decision: 'APPROVED', from: 'gestor@acme.test' },
    },
    {
      at: new Date('2026-09-23T12:00:06Z'),
      type: 'RETRY_SCHEDULED',
      data: { error: 'ECONNRESET secret-host', delaySeconds: 5 },
    },
  ],
  ...patch,
});

describe('renderTimelinePage', () => {
  it('escapes user-controlled text', () => {
    const html = renderTimelinePage(base());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &quot;SP&quot;');
  });
  it('masks the approver e-mail and never prints raw error text', () => {
    const html = renderTimelinePage(base());
    expect(html).toContain('g***@acme.test');
    expect(html).not.toContain('gestor@acme.test');
    expect(html).not.toContain('ECONNRESET');
    expect(html).not.toContain('secret-host');
    expect(html).toContain('transitório');
  });
  it('refreshes every 2s while the run is not terminal', () => {
    expect(renderTimelinePage(base())).toContain(
      '<meta http-equiv="refresh" content="2">',
    );
  });
  it.each(['COMPLETED', 'FAILED', 'EXPIRED'] as const)(
    'does not refresh when %s',
    (status) => {
      expect(renderTimelinePage(base({ status }))).not.toContain('http-equiv="refresh"');
    },
  );
  it('labels a FAILED run error as permanente', () => {
    expect(renderTimelinePage(base({ status: 'FAILED' }))).toContain('permanente');
  });
  it('shows the amount and events in Portuguese', () => {
    const html = renderTimelinePage(base());
    expect(html).toContain(escapeHtml(formatBRL(84000)));
    expect(html).toContain('Pedido criado');
    expect(html).toContain('Decisão recebida');
  });
});
```
Add the imports `import { escapeHtml } from '../shared/html';` and `import { formatBRL } from '../mail/format';`. The amount is asserted through `formatBRL` rather than a literal because its output contains NBSP, which the Write tool loses (lesson 0001).

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.config.js src/runs/timeline-page.spec.ts`
Expected: FAIL (`Cannot find module './timeline-page'`).

- [ ] **Step 3: Implement** `src/runs/timeline-page.ts`:
```ts
import { formatBRL, formatDeadline } from '../mail/format';
import {
  ACCENT,
  ACCENT_TINT,
  FONT,
  INK,
  MUTED,
  RULE,
  escapeHtml,
  maskEmail,
} from '../shared/html';
import { CATEGORY_LABEL } from './reimbursement-input';
import { RunView } from './runs.service';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'EXPIRED',
]);

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Na fila',
  RUNNING: 'Em análise',
  WAITING_APPROVAL: 'Aguardando aprovação',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  EXPIRED: 'Expirado',
};

const EVENT_LABEL: Record<string, string> = {
  CREATED: 'Pedido criado',
  CLAIMED: 'Agente começou a analisar',
  LEASE_LOST: 'Worker anterior perdeu o lease',
  RETRY_SCHEDULED: 'Nova tentativa agendada',
  RELEASED: 'Devolvido à fila no desligamento',
  APPROVAL_REQUESTED: 'Aprovação solicitada',
  APPROVAL_SENT: 'E-mail enviado ao gestor',
  DECISION_RECEIVED: 'Decisão recebida',
  RESUMED: 'Agente retomou',
  ACTION_RECORDED: 'Ação registrada',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  EXPIRED: 'Expirou sem resposta',
};

const DECISION_LABEL: Record<string, string> = {
  APPROVED: 'aprovado',
  REJECTED: 'recusado',
};

type Data = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function eventDetail(type: string, data: Data): string {
  switch (type) {
    case 'DECISION_RECEIVED':
      return `${DECISION_LABEL[str(data.decision)] ?? ''} por ${maskEmail(str(data.from))}`;
    case 'ACTION_RECORDED':
      return DECISION_LABEL[str(data.decision)] ?? '';
    case 'RETRY_SCHEDULED':
      return 'erro transitório';
    case 'FAILED':
      return 'erro permanente';
    case 'CLAIMED':
      return `tentativa ${String(data.attempts ?? '')}`;
    default:
      return '';
  }
}

export function renderTimelinePage(v: RunView): string {
  const terminal = TERMINAL_STATUSES.has(v.status);
  const refresh = terminal ? '' : '<meta http-equiv="refresh" content="2">';
  const amount = formatBRL(v.input.amountCents);
  const errorClass = v.lastError
    ? v.status === 'FAILED'
      ? 'permanente'
      : 'transitório'
    : null;

  const rows = v.timeline
    .map((e) => {
      const detail = eventDetail(e.type, (e.data ?? {}) as Data);
      return `<li style="padding:10px 0;border-top:1px solid ${RULE}"><span style="color:${MUTED};font-size:13px">${escapeHtml(formatDeadline(e.at))}</span><br><strong>${escapeHtml(EVENT_LABEL[e.type] ?? e.type)}</strong>${detail ? ` <span style="color:${MUTED}">· ${escapeHtml(detail)}</span>` : ''}</li>`;
    })
    .join('');

  const approval = v.approval
    ? `<p style="margin:16px 0 0">Aprovador: <strong>${escapeHtml(maskEmail(v.input.approverEmail))}</strong><br><span style="color:${MUTED};font-size:13px">Prazo: ${escapeHtml(formatDeadline(v.approval.expiresAt))} (horário de Brasília)</span>${v.approval.decision ? `<br>Decisão: <strong>${escapeHtml(DECISION_LABEL[v.approval.decision] ?? v.approval.decision)}</strong>` : ''}${v.approval.note ? `<br><span style="color:${MUTED}">${escapeHtml(v.approval.note)}</span>` : ''}</p>`
    : '';

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>mailgate · ${escapeHtml(STATUS_LABEL[v.status] ?? v.status)}</title></head><body style="margin:0;background:#fff;color:${INK};font-family:${FONT};font-size:15px;line-height:1.6"><main style="max-width:560px;margin:0 auto;padding:24px 16px"><p style="margin:0;color:${MUTED};font-size:13px">mailgate · run ${escapeHtml(v.id.slice(0, 8))}</p><h1 style="margin:4px 0 0;font-size:22px">${escapeHtml(STATUS_LABEL[v.status] ?? v.status)}</h1><div style="margin-top:16px;background:${ACCENT_TINT};border-radius:8px;padding:14px 16px"><span style="display:block;font-size:12px;color:${MUTED}">Valor</span><span style="display:block;font-size:26px;font-weight:700;color:${ACCENT}">${escapeHtml(amount)}</span></div><p style="margin:16px 0 0">${escapeHtml(v.input.description)}<br><span style="color:${MUTED};font-size:13px">${escapeHtml(CATEGORY_LABEL[v.input.category])} · tentativas: ${v.attempts}${errorClass ? ` · último erro: ${errorClass}` : ''}</span></p>${approval}<ol style="list-style:none;margin:24px 0 0;padding:0">${rows}</ol></main></body></html>`;
}
```

Add `| 'RELEASED'` to `RunEventType` in `src/runs/run-events.ts`.

In `scripts/render-mocks.ts`, add two timeline mocks built with `renderTimelinePage`:
- a `WAITING_APPROVAL` view with CREATED, CLAIMED, APPROVAL_REQUESTED and APPROVAL_SENT;
- a `COMPLETED` view that adds DECISION_RECEIVED, RESUMED, ACTION_RECORDED and COMPLETED, with the same amount and description as the approval mock.

Write them to `docs/mocks/timeline-waiting.html` and `docs/mocks/timeline-completed.html`.

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.config.js src/runs
npm run lint
npm run typecheck
npm run render:mocks
```
Expected: PASS; four new mock files exist.

- [ ] **Step 5: Visual approval gate.** Load the `impeccable` skill, then open `docs/mocks/timeline-waiting.html`, `timeline-completed.html`, `late-reply-decided.html` and `late-reply-expired.html` in the browser preview. Screenshot each and send them to the user. **The window does not close until the user explicitly approves the four screens.** On approval, mark `docs/01-specs/0005` and `0006` as `approved` (file `approved:` line and index).

- [ ] **Step 6: Checkpoint.** Ask the user whether to commit (`feat(runs): timeline page renderer and mocks`).

---

## Window w2 — hardening

### Task 3: Migration for all schema changes

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_f6_hardening/migration.sql`
- Modify: `src/inbound/inbound-event.repository.ts` (the `InboundOutcome` type)

**Interfaces:**
- Produces:
  - columns `approval_requests.late_reply_sent` (bool, default false), `decided_at` (timestamptz null), `send_attempts` (int, default 0), `next_send_at` (timestamptz null) and `send_lease_until` (timestamptz null);
  - Prisma fields `lateReplySent`, `decidedAt`, `sendAttempts`, `nextSendAt` and `sendLeaseUntil`;
  - `InboundOutcome` gains `'IGNORED_EXPIRED' | 'FAILED'`.

- [ ] **Step 1: Write the failing test** in `test/approvals/schema.int-spec.ts`:
```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { newPrisma, truncateAll } from '../helpers/db';

describe('f6 schema', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('accepts the new inbound outcomes', async () => {
    for (const outcome of ['IGNORED_EXPIRED', 'FAILED']) {
      await prisma.inboundEvent.create({
        data: { providerEventId: `e_${outcome}`, payload: {}, outcome },
      });
    }
    expect(await prisma.inboundEvent.count()).toBe(2);
  });

  it('rejects an unknown outcome', async () => {
    await expect(
      prisma.inboundEvent.create({
        data: { providerEventId: 'e_x', payload: {}, outcome: 'NOPE' },
      }),
    ).rejects.toThrow();
  });

  it('has the new approval columns with defaults', async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'approval_requests'`;
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'late_reply_sent',
        'decided_at',
        'send_attempts',
        'next_send_at',
        'send_lease_until',
      ]),
    );
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.int.config.js --runInBand test/approvals/schema.int-spec.ts`
Expected: FAIL. The CHECK constraint violates on `IGNORED_EXPIRED`, and the columns are missing.

- [ ] **Step 3: Implement.** Add to `model ApprovalRequest` in `schema.prisma`:
```prisma
  lateReplySent     Boolean   @default(false) @map("late_reply_sent")
  decidedAt         DateTime? @map("decided_at") @db.Timestamptz(3)
  sendAttempts      Int       @default(0) @map("send_attempts")
  nextSendAt        DateTime? @map("next_send_at") @db.Timestamptz(3)
  sendLeaseUntil    DateTime? @map("send_lease_until") @db.Timestamptz(3)
```
Run `npx prisma migrate dev --create-only --name f6_hardening`, then make the migration contain exactly:
```sql
ALTER TABLE "approval_requests"
  ADD COLUMN "late_reply_sent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "decided_at" TIMESTAMPTZ(3),
  ADD COLUMN "send_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_send_at" TIMESTAMPTZ(3),
  ADD COLUMN "send_lease_until" TIMESTAMPTZ(3);

ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_outcome_check";
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_outcome_check" CHECK (outcome IS NULL OR outcome IN
  ('PROCESSED','CLARIFICATION_SENT','IGNORED_UNCLEAR','IGNORED_UNKNOWN_THREAD','IGNORED_SENDER','IGNORED_ALREADY_DECIDED','IGNORED_EXPIRED','FAILED'));
```
Then run `npx prisma generate`. In `InboundOutcome`, add `| 'IGNORED_EXPIRED' | 'FAILED'`.

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.int.config.js --runInBand test/approvals/schema.int-spec.ts
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`feat(db): f6 hardening migration`).

### Task 4: Graceful shutdown drains the worker (backlog 0005, D006)

**Files:**
- Modify:
  - `src/config/config.ts` (+`SHUTDOWN_GRACE_MS`), `src/config/config.spec.ts`
  - `src/prisma/prisma.service.ts`
  - `src/worker/worker.loop.ts`, `src/worker/worker.loop.spec.ts`
  - `src/worker/worker.service.ts`, `src/worker/errors.ts`, `src/worker/agent-step.ts`
  - `src/agent/llm-client.ts`, `src/agent/anthropic-llm-client.ts`, `src/agent/agent-runner.ts`
  - `src/runs/run.repository.ts`
  - `docker-compose.yml`
- Create: `src/prisma/prisma.service.spec.ts`, `test/worker/shutdown.int-spec.ts`

**Interfaces:**
- Produces:
  - `AgentStep.run(run: Run, lease: Lease, signal?: AbortSignal): Promise<void>`;
  - `LlmRequest.signal?: AbortSignal`;
  - `RunRepository.releaseForShutdown(lease: Lease): Promise<void>`: fenced; status `PENDING`, lease cleared, `attempts = greatest(attempts - 1, 0)`, event `RELEASED`;
  - `WorkerService.abortInFlight(): void`;
  - `ShutdownAbortError`, with `classifyError` returning `'aborted'`;
  - `WorkerLoop.beforeApplicationShutdown(): Promise<void>`.

- [ ] **Step 1: Write failing tests**

`src/prisma/prisma.service.spec.ts`:
```ts
import { PrismaService } from './prisma.service';

describe('PrismaService lifecycle', () => {
  it('disconnects in onApplicationShutdown, not in onModuleDestroy (adr 0008)', () => {
    const proto = PrismaService.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.onApplicationShutdown).toBe('function');
    expect(proto.onModuleDestroy).toBeUndefined();
  });
});
```

Append to `src/config/config.spec.ts`:
```ts
it('rejects SHUTDOWN_GRACE_MS >= 15000 (compose stop_grace_period)', () => {
  expect(() =>
    loadConfig({ DATABASE_URL: 'postgresql://x', SHUTDOWN_GRACE_MS: '15000' }),
  ).toThrow(/SHUTDOWN_GRACE_MS/);
});
it('defaults SHUTDOWN_GRACE_MS to 8000', () => {
  expect(loadConfig({ DATABASE_URL: 'postgresql://x' }).SHUTDOWN_GRACE_MS).toBe(8000);
});
```

Append to `src/worker/worker.loop.spec.ts`:
```ts
describe('WorkerLoop shutdown', () => {
  const cfg = (grace = '50') =>
    loadConfig({
      DATABASE_URL: 'postgresql://x',
      WORKER_ENABLED: 'false',
      SHUTDOWN_GRACE_MS: grace,
    });
  const side = () => ({
    outbox: { dispatch: jest.fn().mockResolvedValue(0) },
    inbound: { processNext: jest.fn().mockResolvedValue(false) },
    expiry: { expireDue: jest.fn().mockResolvedValue(0) },
  });

  it('waits for the in-flight run before resolving', async () => {
    let finish!: () => void;
    const worker = {
      processNextRun: jest.fn(
        () => new Promise<boolean>((r) => (finish = () => r(false))),
      ),
      abortInFlight: jest.fn(),
    };
    const s = side();
    const loop = new WorkerLoop(
      cfg('5000'),
      worker as unknown as WorkerService,
      s.outbox as unknown as OutboxService,
      s.inbound as unknown as InboundProcessor,
      s.expiry as unknown as ExpiryService,
    );
    void loop.tickRuns();
    let done = false;
    const p = loop.beforeApplicationShutdown().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    finish();
    await p;
    expect(done).toBe(true);
    expect(worker.abortInFlight).not.toHaveBeenCalled();
  });

  it('aborts the in-flight run when the grace period runs out', async () => {
    let finish!: () => void;
    const worker = {
      processNextRun: jest.fn(
        () => new Promise<boolean>((r) => (finish = () => r(false))),
      ),
      abortInFlight: jest.fn(() => finish()),
    };
    const s = side();
    const loop = new WorkerLoop(
      cfg('50'),
      worker as unknown as WorkerService,
      s.outbox as unknown as OutboxService,
      s.inbound as unknown as InboundProcessor,
      s.expiry as unknown as ExpiryService,
    );
    void loop.tickRuns();
    await loop.beforeApplicationShutdown();
    expect(worker.abortInFlight).toHaveBeenCalledTimes(1);
  });

  it('claims no new run once stopping', async () => {
    const worker = {
      processNextRun: jest.fn().mockResolvedValue(true),
      abortInFlight: jest.fn(),
    };
    const s = side();
    const loop = new WorkerLoop(
      cfg(),
      worker as unknown as WorkerService,
      s.outbox as unknown as OutboxService,
      s.inbound as unknown as InboundProcessor,
      s.expiry as unknown as ExpiryService,
    );
    await loop.beforeApplicationShutdown();
    await loop.tickRuns();
    await loop.tickSide();
    expect(worker.processNextRun).not.toHaveBeenCalled();
    expect(s.outbox.dispatch).not.toHaveBeenCalled();
  });
});
```

`test/worker/shutdown.int-spec.ts`:
```ts
import type { LlmClient, LlmRequest } from '../../src/agent/llm-client';
import type Anthropic from '@anthropic-ai/sdk';
import { AgentRunner } from '../../src/agent/agent-runner';
import { PrismaClient } from '../../src/generated/prisma/client';
import { WorkerService } from '../../src/worker/worker.service';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness } from '../helpers/harness';

/** Hangs until its request signal aborts, like the Anthropic SDK does. */
class HangingLlm implements LlmClient {
  createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    return new Promise((_, reject) => {
      req.signal?.addEventListener('abort', () =>
        reject(new Error('Request was aborted.')),
      );
    });
  }
}

describe('shutdown abort', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('releases the run to PENDING and gives the attempt back', async () => {
    const h = buildHarness(prisma);
    const agent = new AgentRunner(
      h.cfg,
      prisma,
      h.runs,
      h.approvals,
      h.actions,
      new HangingLlm(),
    );
    const worker = new WorkerService(h.cfg, h.runs, agent);
    const run = await h.runs.create(validInput());

    const processing = worker.processNextRun();
    await new Promise((r) => setTimeout(r, 200));
    worker.abortInFlight();
    await processing;

    const after = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
    });
    expect(
      await prisma.runEvent.count({ where: { runId: run.id, type: 'RELEASED' } }),
    ).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run:
```bash
npx jest -c jest.config.js src/prisma src/config src/worker
npx jest -c jest.int.config.js --runInBand test/worker/shutdown.int-spec.ts
```
Expected: FAIL. `onModuleDestroy` is defined, `SHUTDOWN_GRACE_MS` is undefined, `beforeApplicationShutdown` and `abortInFlight` are not functions.

- [ ] **Step 3: Implement**

`src/config/config.ts`:
- add `SHUTDOWN_GRACE_MS: z.coerce.number().int().min(100).default(8000),` to the object;
- add in `superRefine`:
```ts
    // docker-compose stop_grace_period is 15s; drain must finish before SIGKILL (adr 0008)
    if (cfg.SHUTDOWN_GRACE_MS >= 15000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SHUTDOWN_GRACE_MS must be shorter than 15000 (stop_grace_period)',
        path: ['SHUTDOWN_GRACE_MS'],
      });
    }
```

`src/prisma/prisma.service.ts`:
- replace `OnModuleDestroy` with `OnApplicationShutdown`;
- rename the method to `onApplicationShutdown`;
- comment: `// last shutdown phase: WorkerLoop drains in beforeApplicationShutdown first (adr 0008)`.

`src/worker/errors.ts`:
```ts
/** The worker is shutting down and aborted the in-flight run (adr 0008). */
export class ShutdownAbortError extends Error {
  constructor() {
    super('aborted by shutdown');
    this.name = 'ShutdownAbortError';
  }
}

export type ErrorKind = 'lease_lost' | 'permanent' | 'transient' | 'aborted';
```
Add `if (e instanceof ShutdownAbortError) return 'aborted';` as the first line of `classifyError`.

`src/agent/llm-client.ts`: add `signal?: AbortSignal;` to `LlmRequest`.

`src/agent/anthropic-llm-client.ts`: pass `{ signal: req.signal }` as request options on both `messages.create` calls. On the fallback path, merge with `headers` into one options object: `{ headers: {...}, signal: req.signal }`.

`src/worker/agent-step.ts`: change the signature to `run(run: Run, lease: Lease, signal?: AbortSignal): Promise<void>;` and update `StubAgentStep` to match.

`src/agent/agent-runner.ts`:
- `async run(run: Run, lease: Lease, signal?: AbortSignal)`;
- pass `signal` into `this.llm.createMessage({ ..., signal })`;
- right after the call, when `signal?.aborted`, throw `new ShutdownAbortError()`. Also wrap the call:
```ts
      let response: Anthropic.Message;
      try {
        response = await this.llm.createMessage({ system: ..., tools: TOOLS, messages, signal });
      } catch (e) {
        if (signal?.aborted) throw new ShutdownAbortError();
        throw e;
      }
```

`src/runs/run.repository.ts`:
```ts
  /** Shutdown abort: hand the run back without consuming the attempt (adr 0008). */
  async releaseForShutdown(lease: Lease): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE runs SET status = 'PENDING', lease_token = NULL, lease_until = NULL,
               attempts = GREATEST(attempts - 1, 0), updated_at = now()
         WHERE id = ${lease.runId}::uuid AND lease_token = ${lease.token}::uuid AND status = 'RUNNING'`;
      if (n === 0) throw new LeaseLostError(lease.runId);
      await appendRunEvent(tx, lease.runId, 'RELEASED');
    });
  }
```

`src/worker/worker.service.ts`:
- add `private inFlight?: AbortController;` and `abortInFlight(): void { this.inFlight?.abort(); }`;
- in `processNextRun`, wrap the agent call:
```ts
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      await this.agent.run(run, lease, controller.signal);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const kind = classifyError(e);
      if (kind === 'aborted') {
        await this.ignoreLeaseLost(() => this.runs.releaseForShutdown(lease));
      } else if (kind === 'lease_lost') {
        ...unchanged
      }
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
```

`src/worker/worker.loop.ts`:
- implement `OnApplicationBootstrap, BeforeApplicationShutdown` and drop `OnApplicationShutdown`;
- replace the busy flags with in-flight promises:
```ts
  private stopping = false;
  private runsInFlight: Promise<void> | null = null;
  private sideInFlight: Promise<void> | null = null;

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.runsTimer) clearInterval(this.runsTimer);
    if (this.sideTimer) clearInterval(this.sideTimer);
    const drained = Promise.allSettled(
      [this.runsInFlight, this.sideInFlight].filter(Boolean),
    ).then(() => true);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), this.cfg.SHUTDOWN_GRACE_MS);
    });
    const ok = await Promise.race([drained, timeout]);
    clearTimeout(timer);
    if (!ok) {
      this.logger.warn('shutdown grace exceeded; aborting in-flight run');
      this.worker.abortInFlight();
      await Promise.race([drained, new Promise((r) => setTimeout(r, 1000))]);
    }
  }

  tickRuns(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.runsInFlight) return this.runsInFlight;
    this.runsInFlight = this.drainRuns().finally(() => {
      this.runsInFlight = null;
    });
    return this.runsInFlight;
  }

  private async drainRuns(): Promise<void> {
    try {
      for (
        let i = 0;
        i < RUNS_PER_TICK && !this.stopping && (await this.worker.processNextRun());
        i++
      ) {
        /* keep draining */
      }
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : String(e));
    }
  }

  tickSide(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.sideInFlight) return this.sideInFlight;
    this.sideInFlight = this.drainSide().finally(() => {
      this.sideInFlight = null;
    });
    return this.sideInFlight;
  }
```
Move the old `tickSide` body into `private async drainSide()` without the busy flag.

The existing first test in `worker.loop.spec.ts` calls `void loop.tickRuns(); await loop.tickSide();`. It must still pass: the two loops are independent.

`docker-compose.yml`: add `stop_grace_period: 15s` under `api:`.

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.config.js
npx jest -c jest.int.config.js --runInBand test/worker
npm run lint
npm run typecheck
```
Expected: all PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`fix(worker): drain in-flight work before prisma disconnects`).

### Task 5: RESUMED written with the fenced save (backlog 0006, D007)

**Files:**
- Modify: `src/runs/run.repository.ts` (`saveMessages` gains an optional event), `src/agent/agent-runner.ts`
- Test: `test/agent/agent-pause.int-spec.ts` (append)

**Interfaces:**
- Produces: `RunRepository.saveMessages(lease, messages, leaseSeconds, event?: { type: RunEventType; data: Record<string, unknown> }): Promise<void>`. With `event`, the fenced update and the event insert share one transaction.

- [ ] **Step 1: Write the failing test.** Append to `test/agent/agent-pause.int-spec.ts`, reusing its existing imports and `beforeEach`, plus `import { sentApproval } from '../helpers/harness'` and `replyPayload`:
```ts
  it('writes RESUMED once even if the process dies before the resume is saved', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await h.deliver(
      'evt_r',
      replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'aprovo' }),
    );
    await h.inbound.processNext();

    // first resume: crash on the save that carries the tool_result
    const spy = jest
      .spyOn(h.runs, 'saveMessages')
      .mockRejectedValueOnce(new Error('simulated crash'));
    await h.worker.processNextRun();
    spy.mockRestore();
    await prisma.run.update({ where: { id: run.id }, data: { leaseUntil: new Date(0) } });

    h.llm.push(
      toolUse('record_decision', { decision: 'APPROVED', reason: 'gestor aprovou' }),
      endTurn(),
    );
    await h.worker.processNextRun();

    expect(
      await prisma.runEvent.count({ where: { runId: run.id, type: 'RESUMED' } }),
    ).toBe(1);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      'COMPLETED',
    );
  });
```
If `endTurn` or `replyPayload` isn't imported in that file yet, add them from `../fakes/scripted-llm` and `../fakes/fake-mail`.

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.int.config.js --runInBand test/agent/agent-pause.int-spec.ts -t RESUMED`
Expected: FAIL (`expected 1, received 2`).

- [ ] **Step 3: Implement.** In `run.repository.ts`, replace `saveMessages`:
```ts
  async saveMessages(
    lease: Lease,
    messages: Anthropic.MessageParam[],
    leaseSeconds: number,
    event?: { type: RunEventType; data: Record<string, unknown> },
  ): Promise<void> {
    const write = async (db: Db) => {
      const n = await db.$executeRaw`
        UPDATE runs SET messages = ${JSON.stringify(messages)}::jsonb,
               lease_until = now() + make_interval(secs => ${leaseSeconds}::float8), updated_at = now()
         WHERE id = ${lease.runId}::uuid AND lease_token = ${lease.token}::uuid AND status = 'RUNNING'`;
      if (n === 0) throw new LeaseLostError(lease.runId);
      if (event) await appendRunEvent(db, lease.runId, event.type, event.data);
    };
    if (!event) return write(this.prisma);
    await this.prisma.$transaction((tx) => write(tx));
  }
```
(import `RunEventType` from `./run-events`).

In `agent-runner.ts`:
- extend `ToolOutcome` with `{ kind: 'result'; result: Anthropic.ToolResultBlockParam; event?: { type: RunEventType; data: Record<string, unknown> } }`;
- in `requestApproval`'s DECIDED branch, delete the `appendRunEvent(... 'RESUMED' ...)` call and return:
```ts
      return {
        kind: 'result',
        result: okResult(block.id, { decision: existing.decision, note: existing.decisionNote, decidedBy: existing.approverEmail }),
        event: { type: 'RESUMED', data: { approvalId: existing.id, decision: existing.decision } },
      };
```
- in `run()`, save with the event:
```ts
        messages = [...messages, { role: 'user', content: [outcome.result] }];
        await this.runs.saveMessages(lease, messages, this.cfg.LEASE_SECONDS, outcome.event);
```

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.int.config.js --runInBand test/agent
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`fix(agent): write RESUMED in the fenced save transaction`).

### Task 6: Exact expiry in decisions + IGNORED_EXPIRED + expiry drain (backlog 0010, D008)

**Files:**
- Modify: `src/approvals/approval.repository.ts`, `src/inbound/inbound.processor.ts`, `src/expiry/expiry.service.ts`
- Test: `test/expiry/expiry.int-spec.ts` (change the expectation at line ~98 and append), `test/inbound/processor.int-spec.ts` (append)

**Interfaces:**
- Produces:
  - `type Liveness = 'LIVE' | 'DECIDED' | 'EXPIRED' | 'NOT_SENT'`;
  - `ApprovalRepository.liveness(db: Db, id: string, lock = false): Promise<Liveness>`, computed with the DB clock; `lock` adds `FOR UPDATE`;
  - `InboundProcessor.decide` now returns `Promise<Liveness>`: `'LIVE'` when it decided, otherwise the state it found;
  - `ExpiryService.expireDue()` loops until a batch returns fewer than `BATCH`.

- [ ] **Step 1: Write failing tests**

In `test/expiry/expiry.int-spec.ts`, change the existing assertion `.toBe('IGNORED_ALREADY_DECIDED')` (for a reply after expiry) to `.toBe('IGNORED_EXPIRED')`. Then append:
```ts
  it('ignores a reply that arrives after expires_at even before the expiry job runs', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = ${approval.id}::uuid`;
    await h.deliver(
      'evt_late',
      replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'aprovo' }),
    );
    await h.inbound.processNext();

    expect(
      (await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_late' } })).outcome,
    ).toBe('IGNORED_EXPIRED');
    expect(
      (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status,
    ).toBe('SENT');
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      'WAITING_APPROVAL',
    );
  });

  it('drains more than one batch in a single expireDue call', async () => {
    const h = buildHarness(prisma);
    for (let i = 0; i < 55; i++) {
      const r = await h.runs.create(validInput());
      await prisma.run.update({ where: { id: r.id }, data: { status: 'WAITING_APPROVAL' } });
      await h.approvals.createIfAbsent(prisma, {
        runId: r.id,
        toolUseId: `toolu_${i}`,
        approverEmail: 'gestor@acme.test',
        summary: 's',
        recommendation: 'APPROVE',
        rationale: 'r',
        ttlHours: 1,
      });
    }
    await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 minute'`;

    expect(await h.expiry.expireDue()).toBe(55);
    expect(await prisma.approvalRequest.count({ where: { status: 'EXPIRED' } })).toBe(55);
  });
```
(add imports `replyPayload`, `validInput` and `sentApproval` if missing).

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.int.config.js --runInBand test/expiry/expiry.int-spec.ts`
Expected: FAIL. The outcome is `IGNORED_ALREADY_DECIDED` or `PROCESSED`, and `expireDue` returns 50.

- [ ] **Step 3: Implement**

`approval.repository.ts`:
```ts
export type Liveness = 'LIVE' | 'DECIDED' | 'EXPIRED' | 'NOT_SENT';

  /** State of a request on the DB clock (convention 0003); lock=true takes FOR UPDATE (I2). */
  async liveness(db: Db, id: string, lock = false): Promise<Liveness> {
    const rows = lock
      ? await db.$queryRaw<{ state: Liveness }[]>`
          SELECT CASE WHEN status = 'DECIDED' THEN 'DECIDED'
                      WHEN status = 'EXPIRED' OR expires_at <= now() THEN 'EXPIRED'
                      WHEN status = 'SENT' THEN 'LIVE' ELSE 'NOT_SENT' END AS state
            FROM approval_requests WHERE id = ${id}::uuid FOR UPDATE`
      : await db.$queryRaw<{ state: Liveness }[]>`
          SELECT CASE WHEN status = 'DECIDED' THEN 'DECIDED'
                      WHEN status = 'EXPIRED' OR expires_at <= now() THEN 'EXPIRED'
                      WHEN status = 'SENT' THEN 'LIVE' ELSE 'NOT_SENT' END AS state
            FROM approval_requests WHERE id = ${id}::uuid`;
    return rows[0]?.state ?? 'NOT_SENT';
  }
```

`inbound.processor.ts`:
- add `const IGNORED_FOR: Record<Exclude<Liveness, 'LIVE'>, InboundOutcome> = { DECIDED: 'IGNORED_ALREADY_DECIDED', EXPIRED: 'IGNORED_EXPIRED', NOT_SENT: 'IGNORED_ALREADY_DECIDED' };`;
- in `handle`, replace the `approval.status !== 'SENT'` pre-check with:
```ts
    const state = await this.approvals.liveness(this.prisma, approval.id);
    if (state !== 'LIVE')
      return this.events.setOutcome(this.prisma, eventId, IGNORED_FOR[state], link);
```
- in `handleUnclear`, before sending the clarification, re-check: `if ((await this.approvals.liveness(this.prisma, approval.id)) !== 'LIVE') return this.events.setOutcome(this.prisma, eventId, 'IGNORED_UNCLEAR', extra);`
- change `decide` so the transaction returns the state and sets the outcome only when it decided. Other states are recorded after the commit, because Task 10 hooks the late reply there:
```ts
    const state = await this.prisma.$transaction(async (tx) => {
      const s = await this.approvals.liveness(tx, approval.id, true);
      if (s !== 'LIVE') return s;
      await tx.$executeRaw`
        UPDATE approval_requests SET status = 'DECIDED', decision = ${c.decision}, decision_note = ${c.note},
               decision_raw_text = ${event.text}, decided_at = now(), updated_at = now()
         WHERE id = ${approval.id}::uuid`;
      if (!(await this.runs.resumeFromDecision(tx, approval.runId))) {
        throw new Error(`run ${approval.runId} is not WAITING_APPROVAL`);
      }
      await appendRunEvent(tx, approval.runId, 'DECISION_RECEIVED', {
        approvalId: approval.id,
        decision: c.decision,
        from: event.from,
      });
      await this.events.setOutcome(tx, eventId, 'PROCESSED', extra);
      return s;
    });
    if (state !== 'LIVE')
      await this.events.setOutcome(this.prisma, eventId, IGNORED_FOR[state], extra);
    return state;
```
`test/inbound/decision.concurrency.int-spec.ts` expects `['IGNORED_ALREADY_DECIDED','PROCESSED']`, which still holds.

`expiry.service.ts`:
- rename the transaction body to `private expireBatch(): Promise<number>`. Add to its SQL `AND (status = 'SENT' OR send_lease_until IS NULL OR send_lease_until < now())`, so a row the outbox reserved is never expired mid-send (Task 7);
- then:
```ts
  /** Expires due requests batch by batch until a batch comes back short (backlog 0010). */
  async expireDue(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.expireBatch();
      total += n;
      if (n < BATCH) return total;
    }
  }
```

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.int.config.js --runInBand test/expiry test/inbound
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`fix(expiry): exact deadline on decide, IGNORED_EXPIRED, drain loop`).

### Task 7: Outbox reserves the row and backs off (backlogs 0007 + 0010, D009)

**Files:**
- Modify: `src/mail/outbox.service.ts`
- Test: `test/mail/outbox.int-spec.ts` (update the retry test, append new tests)

**Interfaces:**
- Consumes: the Task 3 columns and the Task 6 expiry guard on `send_lease_until`.
- Produces: `OutboxService.dispatch(): Promise<number>`, same signature. It sends only CREATED rows that are live and due; a failure sets `send_attempts` and `next_send_at`.

- [ ] **Step 1: Write failing tests.** In the existing test "keeps CREATED with last_error when sending fails, and sends on the next dispatch", insert this line before the second `dispatch()`:
```ts
    await prisma.$executeRaw`UPDATE approval_requests SET next_send_at = now() - interval '1 second'`;
```
Append:
```ts
  it('backs off after a failure: not retried before next_send_at', async () => {
    const h = buildHarness(prisma);
    const run = await pausedRun(h);
    h.mail.failNextSends = 1;
    await h.outbox.dispatch();
    const [row] = await prisma.$queryRaw<{ send_attempts: number; secs: number }[]>`
      SELECT send_attempts, EXTRACT(EPOCH FROM next_send_at - now())::float8 AS secs
        FROM approval_requests WHERE run_id = ${run.id}::uuid`;
    expect(row.send_attempts).toBe(1);
    expect(row.secs).toBeGreaterThan(25);
    expect(row.secs).toBeLessThanOrEqual(30);
    expect(await h.outbox.dispatch()).toBe(0);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('caps the backoff at one hour', async () => {
    const h = buildHarness(prisma);
    const run = await pausedRun(h);
    await prisma.$executeRaw`UPDATE approval_requests SET send_attempts = 12 WHERE run_id = ${run.id}::uuid`;
    h.mail.failNextSends = 1;
    await h.outbox.dispatch();
    const [row] = await prisma.$queryRaw<{ secs: number }[]>`
      SELECT EXTRACT(EPOCH FROM next_send_at - now())::float8 AS secs FROM approval_requests WHERE run_id = ${run.id}::uuid`;
    expect(row.secs).toBeGreaterThan(3590);
    expect(row.secs).toBeLessThanOrEqual(3600);
  });

  it('never sends a CREATED request whose deadline has passed', async () => {
    const h = buildHarness(prisma);
    await pausedRun(h);
    await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 second'`;
    expect(await h.outbox.dispatch()).toBe(0);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('expiry skips a row the outbox has reserved', async () => {
    const h = buildHarness(prisma);
    await pausedRun(h);
    await prisma.$executeRaw`UPDATE approval_requests SET send_lease_until = now() + interval '1 minute', expires_at = now() - interval '1 second'`;
    expect(await h.expiry.expireDue()).toBe(0);
  });
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.int.config.js --runInBand test/mail/outbox.int-spec.ts`
Expected: FAIL. `send_attempts` is 0, the retry sends immediately, and an expired row is sent.

- [ ] **Step 3: Implement.** Replace `dispatch()` in `outbox.service.ts`:
```ts
const SEND_LEASE_SECONDS = 60;

  /**
   * Reserves one live, due CREATED request at a time (FOR UPDATE SKIP LOCKED + send_lease_until),
   * sends outside any transaction (convention 0004), then marks SENT (D016). adr 0009.
   */
  async dispatch(): Promise<number> {
    let sent = 0;
    for (let i = 0; i < this.cfg.OUTBOX_BATCH; i++) {
      const id = await this.reserve();
      if (!id) break;
      if (await this.sendOne(id)) sent++;
    }
    return sent;
  }

  private async reserve(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH picked AS (
        SELECT id FROM approval_requests
         WHERE status = 'CREATED' AND expires_at > now()
           AND (next_send_at IS NULL OR next_send_at <= now())
           AND (send_lease_until IS NULL OR send_lease_until < now())
         ORDER BY next_send_at NULLS FIRST, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      UPDATE approval_requests a
         SET send_lease_until = now() + make_interval(secs => ${SEND_LEASE_SECONDS}::float8), updated_at = now()
        FROM picked WHERE a.id = picked.id
      RETURNING a.id`;
    return rows[0]?.id ?? null;
  }

  private async sendOne(id: string): Promise<boolean> {
    const a = await this.prisma.approvalRequest.findUniqueOrThrow({
      where: { id },
      include: { run: true },
    });
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
      const res = await this.mail.send({
        to: a.approverEmail,
        ...email,
        idempotencyKey: `approval-${a.id}`,
      });
      return await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.approvalRequest.updateMany({
          where: { id: a.id, status: 'CREATED' },
          data: {
            status: 'SENT',
            providerMessageId: res.messageId,
            providerThreadId: res.threadId,
            lastError: null,
            sendLeaseUntil: null,
          },
        });
        if (count === 1) {
          await appendRunEvent(tx, a.runId, 'APPROVAL_SENT', {
            approvalId: a.id,
            threadId: res.threadId,
          });
        }
        return count === 1;
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`send failed for approval ${a.id}: ${message}`);
      // backoff on the DB clock (convention 0003): 30s, 60s, 120s ... capped at 1h
      await this.prisma.$executeRaw`
        UPDATE approval_requests
           SET last_error = ${message}, send_lease_until = NULL, updated_at = now(),
               next_send_at = now() + make_interval(secs => LEAST(30 * power(2, send_attempts), 3600)::float8),
               send_attempts = send_attempts + 1
         WHERE id = ${a.id}::uuid AND status = 'CREATED'`;
      return false;
    }
  }
```
In `UPDATE ... SET`, every right-hand side reads the old row values, so `power(2, send_attempts)` uses the count from before the increment.

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.int.config.js --runInBand test/mail test/expiry test/inbound
npm run lint
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`fix(outbox): reserve rows and back off failing sends`).

### Task 8: Inbound dead-letter + guarded setOutcome (backlog 0009, D010)

**Files:**
- Modify: `src/inbound/inbound-event.repository.ts`, `src/inbound/inbound.processor.ts`
- Test: `test/inbound/processor.int-spec.ts` (append)

**Interfaces:**
- Produces:
  - `InboundEventRepository.setOutcome(...)` now returns `Promise<boolean>` (false when an outcome was already set);
  - `InboundEventRepository.markFailed(eventId: string, error: string): Promise<void>`.

- [ ] **Step 1: Write failing tests**
```ts
  it('dead-letters an event as FAILED once it exhausts MAX_ATTEMPTS', async () => {
    const h = buildHarness(prisma, { cfg: { MAX_ATTEMPTS: '2', LEASE_SECONDS: '1' } });
    const { approval } = await sentApproval(h, prisma);
    jest.spyOn(h.classifier, 'classify').mockRejectedValue(new Error('llm down'));
    await h.deliver(
      'evt_dead',
      replyPayload({ threadId: approval.providerThreadId, from: 'gestor@acme.test', text: 'aprovo' }),
    );
    await h.inbound.processNext();
    await prisma.inboundEvent.update({ where: { providerEventId: 'evt_dead' }, data: { leaseUntil: null } });
    await h.inbound.processNext();

    expect(
      await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_dead' } }),
    ).toMatchObject({ outcome: 'FAILED', lastError: 'llm down' });
  });

  it('never overwrites an outcome already recorded', async () => {
    const h = buildHarness(prisma);
    await prisma.inboundEvent.create({
      data: { providerEventId: 'evt_done', payload: {}, outcome: 'PROCESSED' },
    });
    expect(await h.events.setOutcome(prisma, 'evt_done', 'IGNORED_ALREADY_DECIDED')).toBe(false);
    expect(
      (await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'evt_done' } })).outcome,
    ).toBe('PROCESSED');
  });
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.int.config.js --runInBand test/inbound/processor.int-spec.ts -t "dead-letters|overwrites"`
Expected: FAIL. The outcome stays null, and `setOutcome` returns undefined and overwrites.

- [ ] **Step 3: Implement.** In the repository:
```ts
  /** Sets the terminal outcome once; false when another pass already set one (backlog 0009). */
  async setOutcome(
    db: Db,
    eventId: string,
    outcome: InboundOutcome,
    extra: { approvalRequestId?: string; classification?: string } = {},
  ): Promise<boolean> {
    const { count } = await db.inboundEvent.updateMany({
      where: { providerEventId: eventId, outcome: null },
      data: { outcome, processedAt: new Date(), leaseUntil: null, lastError: null, ...extra },
    });
    return count === 1;
  }

  /** Dead-letter: keep the last error, stop retrying. */
  async markFailed(eventId: string, error: string): Promise<void> {
    await this.prisma.inboundEvent.updateMany({
      where: { providerEventId: eventId, outcome: null },
      data: { outcome: 'FAILED', lastError: error, leaseUntil: null, processedAt: new Date() },
    });
  }
```
In `InboundProcessor.processNext`, replace the catch body:
```ts
      const message = e instanceof Error ? e.message : String(e);
      if (row.attempts >= this.cfg.MAX_ATTEMPTS) {
        this.logger.error(`inbound ${row.providerEventId} dead-lettered after ${row.attempts} attempts: ${message}`);
        await this.events.markFailed(row.providerEventId, message);
      } else {
        this.logger.warn(`inbound ${row.providerEventId} failed (attempt ${row.attempts}): ${message}`);
        await this.events.recordError(row.providerEventId, message);
      }
```
`processedAt: new Date()` is an audit stamp, not a lease or deadline comparison, so convention 0003 does not apply. It matches the existing code.

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.int.config.js --runInBand test/inbound
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`fix(inbound): dead-letter exhausted events and guard outcome writes`).

### Task 9: npm audit — override mysql2 (backlog 0004, D011)

**Files:**
- Modify: `package.json` (add `overrides`), `package-lock.json` (regenerated in alpine)

- [ ] **Step 1: Record the baseline**

Run: `npm audit --omit=dev 2>&1 | tail -5`
Expected: `4 high severity vulnerabilities`.

- [ ] **Step 2: Implement.** Add to `package.json` at top level:
```json
  "overrides": {
    "mysql2": "^3.24.4"
  },
```
Regenerate the lockfile per lesson 0002:
```bash
before=$(grep -c '"node_modules/@emnapi' package-lock.json)
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only
after=$(grep -c '"node_modules/@emnapi' package-lock.json); echo "$before -> $after"
npm ci
```

- [ ] **Step 3: Verify**

Run:
```bash
npm audit --omit=dev 2>&1 | tail -5
npm ls mysql2
docker compose up --build -d
curl -fsS localhost:3000/health
docker compose down
```
Expected:
- audit reports 2 high severity vulnerabilities, only `deepmerge-ts`, `@prisma/config` and `prisma`;
- `mysql2@3.24.x` (or newer 3.x);
- the `@emnapi` count did not drop;
- the `migrate` service exits 0, and health returns 200.

- [ ] **Step 4: Run the full suite**

Run:
```bash
npm run lint
npm run typecheck
npm test
npm run test:int
```
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`chore(deps): override mysql2 to patched 3.x`).

---

## Window w3 — late reply + timeline backend

### Task 10: Late reply once per approval (backlog 0002, D003)

**Files:**
- Modify: `src/inbound/inbound.processor.ts`
- Test: `test/inbound/late-reply.int-spec.ts` (new)

**Interfaces:**
- Consumes:
  - `renderLateReplyEmail` (Task 1);
  - `Liveness` and `approvals.liveness` (Task 6);
  - columns `late_reply_sent` and `decided_at` (Task 3).
- Produces: `InboundProcessor.sendLateReply(event: InboundEvent, approvalId: string): Promise<void>` (private).

- [ ] **Step 1: Write failing tests** in `test/inbound/late-reply.int-spec.ts`:
```ts
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('late reply (pdr 0005)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  const reply = (threadId: string | null, text: string, from = 'gestor@acme.test') =>
    replyPayload({ threadId, from, text });

  it('answers once in-thread when the request is already decided', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('e1', reply(approval.providerThreadId, 'aprovo'));
    await h.inbound.processNext();
    await h.deliver('e2', reply(approval.providerThreadId, 'aprovo de novo'));
    await h.deliver('e3', reply(approval.providerThreadId, 'e mais uma vez'));
    await h.inbound.processNext();
    await h.inbound.processNext();

    const late = h.mail.replies.filter((r) => r.idempotencyKey === `late-${approval.id}`);
    expect(late).toHaveLength(1);
    expect(late[0].text).toContain('Este pedido já foi APROVADO em');
    expect(
      (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).lateReplySent,
    ).toBe(true);
    const outcomes = await prisma.inboundEvent.findMany({
      where: { providerEventId: { in: ['e2', 'e3'] } },
      select: { outcome: true },
    });
    expect(outcomes.map((o) => o.outcome)).toEqual([
      'IGNORED_ALREADY_DECIDED',
      'IGNORED_ALREADY_DECIDED',
    ]);
  });

  it('answers once when the request expired (even before the job ran)', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = ${approval.id}::uuid`;
    await h.deliver('e1', reply(approval.providerThreadId, 'aprovo'));
    await h.inbound.processNext();

    expect(h.mail.replies).toHaveLength(1);
    expect(h.mail.replies[0].text).toContain('Este pedido expirou em');
    expect(
      (await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'e1' } })).outcome,
    ).toBe('IGNORED_EXPIRED');
  });

  it('does not answer another sender (I6)', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('e1', reply(approval.providerThreadId, 'aprovo'));
    await h.inbound.processNext();
    await h.deliver('e2', reply(approval.providerThreadId, 'aprovo', 'intruso@evil.test'));
    await h.inbound.processNext();
    expect(h.mail.replies).toHaveLength(0);
  });

  it('retries the late reply when sending fails, without sending twice', async () => {
    const h = buildHarness(prisma, { cfg: { LEASE_SECONDS: '1' } });
    const { approval } = await sentApproval(h, prisma);
    await h.deliver('e1', reply(approval.providerThreadId, 'aprovo'));
    await h.inbound.processNext();
    h.mail.failNextReplies = 1;
    await h.deliver('e2', reply(approval.providerThreadId, 'aprovo?'));
    await h.inbound.processNext();
    expect(
      (await prisma.inboundEvent.findUniqueOrThrow({ where: { providerEventId: 'e2' } })).outcome,
    ).toBeNull();
    await prisma.inboundEvent.update({ where: { providerEventId: 'e2' }, data: { leaseUntil: null } });
    await h.inbound.processNext();
    expect(h.mail.replies).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.int.config.js --runInBand test/inbound/late-reply.int-spec.ts`
Expected: FAIL (`replies` has length 0).

- [ ] **Step 3: Implement** in `inbound.processor.ts`:
- import `renderLateReplyEmail`;
- in `handle`, change the non-LIVE branch to:
```ts
    if (state !== 'LIVE') {
      if (state !== 'NOT_SENT') await this.sendLateReply(event, approval.id);
      return this.events.setOutcome(this.prisma, eventId, IGNORED_FOR[state], link);
    }
```
- in `decide`, before `if (state !== 'LIVE') await this.events.setOutcome(...)`, add `if (state === 'DECIDED' || state === 'EXPIRED') await this.sendLateReply(event, approval.id);`;
- add:
```ts
  /** At most one late reply per approval (pdr 0005): send first (idempotent key), then flip the flag. */
  private async sendLateReply(event: InboundEvent, approvalId: string): Promise<void> {
    const a = await this.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    if (a.lateReplySent) return;
    const decided = a.status === 'DECIDED' && a.decision;
    const body = renderLateReplyEmail({
      state: decided ? (a.decision as 'APPROVED' | 'REJECTED') : 'EXPIRED',
      at: decided ? (a.decidedAt ?? a.updatedAt) : a.expiresAt,
      note: decided ? a.decisionNote : null,
    });
    await this.mail.reply({
      messageId: event.messageId,
      ...body,
      idempotencyKey: `late-${a.id}`,
    });
    await this.prisma.approvalRequest.updateMany({
      where: { id: a.id, lateReplySent: false },
      data: { lateReplySent: true },
    });
  }
```
The I6 sender check runs before this in `handle`, so only the approver ever reaches it.

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.int.config.js --runInBand test/inbound test/expiry
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`feat(inbound): tell the approver once when a reply is too late`).

### Task 11: GET /runs/:id/timeline (backlog 0003, D004/D005)

**Files:**
- Modify: `src/runs/runs.controller.ts`
- Test: `test/runs/runs-api.int-spec.ts` (append)

**Interfaces:**
- Consumes: `renderTimelinePage(v: RunView): string` (Task 2) and `RunsService.getView(id)`.

- [ ] **Step 1: Write failing tests** (append inside the existing describe, reusing its `app`):
```ts
  describe('GET /runs/:id/timeline', () => {
    it('renders escaped HTML with a strict CSP', async () => {
      const created = await request(app.getHttpServer())
        .post('/runs')
        .send(validInput({ description: `<script>alert('x')</script>` }))
        .expect(201);
      const res = await request(app.getHttpServer())
        .get(`/runs/${created.body.id}/timeline`)
        .expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html; charset=utf-8/);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.text).not.toContain('<script>');
      expect(res.text).toContain('&lt;script&gt;');
      expect(res.text).toContain('g***@acme.test');
      expect(res.text).toContain('http-equiv="refresh"');
    });
    it('404s an unknown run and 400s a non-uuid', async () => {
      await request(app.getHttpServer())
        .get('/runs/5f0c6b8e-2b0a-4c47-9d5f-0e7d2b8a1c3d/timeline')
        .expect(404);
      await request(app.getHttpServer()).get('/runs/nope/timeline').expect(400);
    });
  });
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.int.config.js --runInBand test/runs/runs-api.int-spec.ts -t timeline`
Expected: FAIL (404 on the route).

- [ ] **Step 3: Implement** in `runs.controller.ts`, declared **before** `@Get(':id')` is fine because paths differ:
```ts
const TIMELINE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  @Get(':id/timeline')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', TIMELINE_CSP)
  @Header('X-Content-Type-Options', 'nosniff')
  async timeline(@Param('id', new ParseUUIDPipe()) id: string): Promise<string> {
    const view = await this.runs.getView(id);
    if (!view) throw new NotFoundException();
    return renderTimelinePage(view);
  }
```
(import `Header` from `@nestjs/common` and `renderTimelinePage` from `./timeline-page`). Nest's exception filter answers 400/404 in JSON regardless of the `@Header`, which matches spec 0006. Add the route to `docs/api/openapi.yaml` under `/runs/{id}/timeline` with `200: text/html`, `400` and `404`.

- [ ] **Step 4: Run**

Run:
```bash
npx jest -c jest.int.config.js --runInBand test/runs
npm run lint
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`feat(runs): GET /runs/:id/timeline HTML page`).

---

## Window w4 — OpenAI-compatible adapter

### Task 12: Pure translation Anthropic ↔ chat.completions

**Files:**
- Create: `src/agent/openai-translate.ts`, `src/agent/openai-translate.spec.ts`
- Modify: `package.json` (+`openai` exact), `package-lock.json` (regenerated in alpine, see Global Constraints)

**Interfaces:**
- Produces:
  - `toChatRequest(req: LlmRequest, model: string): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming`;
  - `fromChatCompletion(c: OpenAI.Chat.ChatCompletion): Anthropic.Message`.

- [ ] **Step 1: Add the dependency.** Run `npm view openai version`, then `npm i -E openai@<that version>`. Regenerate the lockfile in `node:22-alpine` with the `@emnapi` check (Global Constraints).

- [ ] **Step 2: Write failing tests** in `src/agent/openai-translate.spec.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { fromChatCompletion, toChatRequest } from './openai-translate';

const tool: Anthropic.Tool = {
  name: 'record_decision',
  description: 'grava',
  input_schema: { type: 'object', properties: { decision: { type: 'string' } } },
};

describe('toChatRequest', () => {
  it('maps system, tools, tool_use and tool_result', () => {
    const r = toChatRequest(
      {
        system: 'SYS',
        tools: [tool],
        messages: [
          { role: 'user', content: 'pedido' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'x', signature: 's' },
              { type: 'text', text: 'vou gravar' },
              { type: 'tool_use', id: 'call_1', name: 'record_decision', input: { decision: 'APPROVED' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' }],
          },
        ] as Anthropic.MessageParam[],
      },
      'gpt-x',
    );
    expect(r.model).toBe('gpt-x');
    expect(r.parallel_tool_calls).toBe(false);
    expect(r.tool_choice).toBe('auto');
    expect(r.max_completion_tokens).toBe(16000);
    expect(r.tools).toEqual([
      { type: 'function', function: { name: 'record_decision', description: 'grava', parameters: tool.input_schema } },
    ]);
    expect(r.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'pedido' },
      {
        role: 'assistant',
        content: 'vou gravar',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'record_decision', arguments: '{"decision":"APPROVED"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ]);
  });

  it('sends null content for an assistant turn with only tool calls', () => {
    const r = toChatRequest(
      {
        system: 'S',
        tools: [],
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'n', input: {} }] },
        ] as Anthropic.MessageParam[],
      },
      'm',
    );
    expect(r.messages[1]).toMatchObject({ role: 'assistant', content: null });
  });
});

const completion = (
  message: Partial<OpenAI.Chat.ChatCompletionMessage>,
  finish_reason: OpenAI.Chat.ChatCompletion.Choice['finish_reason'],
): OpenAI.Chat.ChatCompletion =>
  ({
    id: 'cmpl_1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-x',
    choices: [{ index: 0, finish_reason, logprobs: null, message: { role: 'assistant', content: null, refusal: null, ...message } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }) as OpenAI.Chat.ChatCompletion;

describe('fromChatCompletion', () => {
  it('maps tool_calls to a single tool_use and stop_reason tool_use', () => {
    const m = fromChatCompletion(
      completion(
        {
          content: 'ok',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'record_decision', arguments: '{"decision":"REJECTED"}' } },
            { id: 'call_b', type: 'function', function: { name: 'request_approval', arguments: '{}' } },
          ],
        },
        'tool_calls',
      ),
    );
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content).toEqual([
      { type: 'text', text: 'ok', citations: null },
      { type: 'tool_use', id: 'call_a', name: 'record_decision', input: { decision: 'REJECTED' } },
    ]);
    expect(m.usage).toMatchObject({ input_tokens: 3, output_tokens: 4 });
  });

  it('turns invalid arguments JSON into an empty input', () => {
    const m = fromChatCompletion(
      completion(
        { tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{oops' } }] },
        'tool_calls',
      ),
    );
    expect(m.content).toEqual([{ type: 'tool_use', id: 'c', name: 'n', input: {} }]);
  });

  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
  ] as const)('maps finish_reason %s to %s', (finish, stop) => {
    expect(fromChatCompletion(completion({ content: 'x' }, finish)).stop_reason).toBe(stop);
  });

  it('maps a refusal to stop_reason refusal', () => {
    expect(fromChatCompletion(completion({ refusal: 'no' }, 'stop')).stop_reason).toBe('refusal');
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx jest -c jest.config.js src/agent/openai-translate.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement** `src/agent/openai-translate.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { LlmRequest } from './llm-client';

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

const MAX_COMPLETION_TOKENS = 16000;

function textOf(content: string | Anthropic.ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

function toChatMessages(m: Anthropic.MessageParam): ChatMessage[] {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content } as ChatMessage];
  if (m.role === 'assistant') {
    const text = m.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const calls = m.content
      .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
    ];
  }
  // user turn: tool results first (role:tool), then any text
  const out: ChatMessage[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result')
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: textOf(b.content) });
  }
  const text = m.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (text) out.push({ role: 'user', content: text });
  return out;
}

export function toChatRequest(
  req: LlmRequest,
  model: string,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  return {
    model,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    messages: [{ role: 'system', content: req.system }, ...req.messages.flatMap(toChatMessages)],
    ...(req.tools.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              parameters: t.input_schema as Record<string, unknown>,
            },
          })),
          tool_choice: 'auto' as const,
          // the runner handles one tool per turn (D010)
          parallel_tool_calls: false,
        }
      : {}),
  };
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {}; // the runner's Zod check turns this into an is_error tool_result
  }
}

const STOP: Record<string, Anthropic.Message['stop_reason']> = {
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export function fromChatCompletion(c: OpenAI.Chat.ChatCompletion): Anthropic.Message {
  const choice = c.choices[0];
  const msg = choice.message;
  const content: unknown[] = [];
  if (msg.content) content.push({ type: 'text', text: msg.content, citations: null });
  const first = msg.tool_calls?.find((t) => t.type === 'function');
  if (first && first.type === 'function')
    content.push({
      type: 'tool_use',
      id: first.id,
      name: first.function.name,
      input: parseArgs(first.function.arguments),
    });
  const stop_reason = msg.refusal ? 'refusal' : (STOP[choice.finish_reason] ?? 'end_turn');
  return {
    id: c.id,
    type: 'message',
    role: 'assistant',
    model: c.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: c.usage?.prompt_tokens ?? 0,
      output_tokens: c.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as unknown as Anthropic.Message;
}
```
The `reasoning` field (GPT-OSS on Groq) is simply not read. `thinking` blocks are dropped on send by the text/tool_use filters. If the installed `openai` types name the tool call type differently, e.g. `ChatCompletionMessageFunctionToolCall`, adjust the narrowing so `typecheck` passes without changing behavior.

- [ ] **Step 5: Run**

Run:
```bash
npx jest -c jest.config.js src/agent
npm run lint
npm run typecheck
```
Expected: PASS.

- [ ] **Step 6: Checkpoint.** Ask whether to commit (`feat(llm): anthropic <-> chat.completions translation`).

### Task 13: OpenAiLlmClient, OpenAiReplyClassifier, config and module factories (D012)

**Files:**
- Create: `src/agent/openai-llm-client.ts`, `src/agent/openai-llm-client.spec.ts`, `src/inbound/openai-reply-classifier.ts`, `src/inbound/openai-reply-classifier.spec.ts`
- Modify: `src/config/config.ts`, `src/config/config.spec.ts`, `src/agent/agent.module.ts`, `src/inbound/inbound.module.ts`, `src/inbound/claude-reply-classifier.ts` (export `SYSTEM`, `schema`, `UNCLEAR`, `extractJsonObject` for reuse), `.env.example` (if present; else README Configuration table)

**Interfaces:**
- Consumes: `toChatRequest` and `fromChatCompletion` (Task 12).
- Produces:
  - `OpenAiLlmClient implements LlmClient`, with constructor `(cfg: AppConfig, client?: OpenAI)`;
  - `OpenAiReplyClassifier implements ReplyClassifier`, with constructor `(cfg: AppConfig, client?: OpenAI)`;
  - `createOpenAiSdk(cfg): OpenAI`.

- [ ] **Step 1: Write failing tests**

`src/config/config.spec.ts`:
```ts
it('requires LLM_API_KEY for openai-compatible', () => {
  expect(() =>
    loadConfig({ DATABASE_URL: 'postgresql://x', LLM_PROVIDER: 'openai-compatible' }),
  ).toThrow(/LLM_API_KEY/);
});
it('accepts openai-compatible with a key and no base URL', () => {
  const c = loadConfig({ DATABASE_URL: 'postgresql://x', LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'k' });
  expect(c.LLM_PROVIDER).toBe('openai-compatible');
  expect(c.LLM_STRICT_OUTPUT).toBe(false);
});
```

`src/agent/openai-llm-client.spec.ts`:
```ts
import type OpenAI from 'openai';
import { loadConfig } from '../config/config';
import { OpenAiLlmClient } from './openai-llm-client';

it('calls chat.completions with the translated request and the abort signal', async () => {
  const create = jest.fn().mockResolvedValue({
    id: 'c', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'oi', refusal: null } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const sdk = { chat: { completions: { create } } } as unknown as OpenAI;
  const cfg = loadConfig({ DATABASE_URL: 'postgresql://x', LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'k', LLM_MODEL: 'gpt-x' });
  const signal = new AbortController().signal;
  const m = await new OpenAiLlmClient(cfg, sdk).createMessage({ system: 'S', tools: [], messages: [{ role: 'user', content: 'u' }], signal });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-x' }), { signal });
  expect(m.stop_reason).toBe('end_turn');
});
```

`src/inbound/openai-reply-classifier.spec.ts`:
```ts
import type OpenAI from 'openai';
import { loadConfig } from '../config/config';
import { OpenAiReplyClassifier } from './openai-reply-classifier';

const cfg = (strict = 'false') =>
  loadConfig({ DATABASE_URL: 'postgresql://x', LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'k', LLM_STRICT_OUTPUT: strict });
const sdkReturning = (content: string) => {
  const create = jest.fn().mockResolvedValue({
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
  });
  return { sdk: { chat: { completions: { create } } } as unknown as OpenAI, create };
};

it('parses a valid json_schema answer', async () => {
  const { sdk, create } = sdkReturning('{"decision":"APPROVED","note":"ok"}');
  expect(await new OpenAiReplyClassifier(cfg('true'), sdk).classify('aprovo')).toEqual({ decision: 'APPROVED', note: 'ok' });
  expect(create.mock.calls[0][0].response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
});
it('falls back to UNCLEAR on invalid output', async () => {
  const { sdk } = sdkReturning('não sei');
  expect((await new OpenAiReplyClassifier(cfg(), sdk).classify('?')).decision).toBe('UNCLEAR');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest -c jest.config.js src/config src/agent/openai-llm-client.spec.ts src/inbound/openai-reply-classifier.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`config.ts`:
- `LLM_PROVIDER: z.enum(['anthropic', 'anthropic-compatible', 'openai-compatible']).default('anthropic'),`
- `LLM_STRICT_OUTPUT: z.string().optional().transform((v) => v === 'true'),`
- add to `superRefine`:
```ts
    if (cfg.LLM_PROVIDER === 'openai-compatible' && !cfg.LLM_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LLM_API_KEY is required when LLM_PROVIDER=openai-compatible',
        path: ['LLM_API_KEY'],
      });
    }
```

`src/agent/openai-llm-client.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AppConfig } from '../config/config';
import type { LlmClient, LlmRequest } from './llm-client';
import { fromChatCompletion, toChatRequest } from './openai-translate';

export function createOpenAiSdk(cfg: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: cfg.LLM_API_KEY,
    baseURL: cfg.LLM_BASE_URL, // undefined -> api.openai.com
    timeout: cfg.LLM_TIMEOUT_MS,
    maxRetries: 0, // the worker's backoff retries (adr 0007)
  });
}

/** Groq/OpenAI over chat.completions, returning Anthropic.Message (adr 0010, convention 0005). */
export class OpenAiLlmClient implements LlmClient {
  private readonly client: OpenAI;
  constructor(private readonly cfg: AppConfig, client?: OpenAI) {
    this.client = client ?? createOpenAiSdk(cfg);
  }
  async createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    const c = await this.client.chat.completions.create(
      toChatRequest(req, this.cfg.LLM_MODEL),
      { signal: req.signal },
    );
    return fromChatCompletion(c);
  }
}
```
`classifyError` in `src/worker/errors.ts` only knows `Anthropic.APIError`. Add the same status mapping for `OpenAI.APIError`:
```ts
  if (e instanceof OpenAI.APIError && typeof e.status === 'number') { ...same branches... }
```
Extract the branches into a local `byStatus(s: number): ErrorKind`, and add a unit case in `src/worker/errors.spec.ts`: `new OpenAI.APIError(429, {}, 'rate', new Headers())` gives `transient`, and `400` gives `permanent`. Check the constructor signature against the installed SDK.

`src/inbound/openai-reply-classifier.ts`:
```ts
import OpenAI from 'openai';
import { z } from 'zod';
import { createOpenAiSdk } from '../agent/openai-llm-client';
import type { AppConfig } from '../config/config';
import { SYSTEM, UNCLEAR, extractJsonObject, schema } from './claude-reply-classifier';
import type { Classification, ReplyClassifier } from './reply-classifier';

export class OpenAiReplyClassifier implements ReplyClassifier {
  private readonly client: OpenAI;
  constructor(private readonly cfg: AppConfig, client?: OpenAI) {
    this.client = client ?? createOpenAiSdk(cfg);
  }
  async classify(text: string): Promise<Classification> {
    const c = await this.client.chat.completions.create({
      model: this.cfg.LLM_MODEL,
      max_completion_tokens: 512,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'reply_classification',
          strict: this.cfg.LLM_STRICT_OUTPUT,
          schema: z.toJSONSchema(schema) as Record<string, unknown>,
        },
      },
    });
    const raw = c.choices[0]?.message?.content ?? '';
    try {
      const parsed = schema.safeParse(JSON.parse(extractJsonObject(raw)));
      return parsed.success ? parsed.data : UNCLEAR;
    } catch {
      return UNCLEAR; // network errors propagate (retried by the inbound loop); bad output does not
    }
  }
}
```
(`z.toJSONSchema` exists in zod 4. With `strict: true`, OpenAI requires `additionalProperties: false`, and zod 4's `toJSONSchema` of `z.object` emits it. Confirm in the test by asserting `create.mock.calls[0][0].response_format.json_schema.schema.additionalProperties === false`.)

In `claude-reply-classifier.ts`, add `export` to `schema`, `SYSTEM`, `UNCLEAR` and `extractJsonObject`.

`agent.module.ts`:
```ts
@Module({
  providers: [
    {
      provide: LLM_CLIENT,
      inject: [APP_CONFIG, { token: ANTHROPIC_SDK, optional: true }],
      useFactory: (cfg: AppConfig, sdk?: Anthropic): LlmClient =>
        cfg.LLM_PROVIDER === 'openai-compatible'
          ? new OpenAiLlmClient(cfg)
          : new AnthropicLlmClient(cfg, sdk),
    },
    AgentRunner,
  ],
  exports: [AgentRunner, LLM_CLIENT],
})
```
`inbound.module.ts` does the same for `REPLY_CLASSIFIER`: `openai-compatible` gives `OpenAiReplyClassifier`, anything else gives `ClaudeReplyClassifier`.

Document the new env values in the README `## Configuration` table: `LLM_PROVIDER=openai-compatible`, `LLM_STRICT_OUTPUT`, and a Groq example with `LLM_BASE_URL=https://api.groq.com/openai/v1` and `LLM_MODEL=openai/gpt-oss-120b`.

- [ ] **Step 4: Run**

Run:
```bash
npm test
npm run test:int
npm run lint
npm run typecheck
```
Expected: PASS. The integration suite still overrides `LLM_CLIENT` and `REPLY_CLASSIFIER` with fakes, so no network is used.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`feat(llm): openai-compatible provider for Groq/OpenAI`).

---

## Window w5 — demo and publication

### Task 14: DEMO mode (D013)

**Files:**
- Create:
  - `src/demo/demo-llm.ts`, `src/demo/demo-llm.spec.ts`
  - `src/demo/keyword-classifier.ts`
  - `src/demo/demo-mail.provider.ts`
  - `src/demo/reply-payload.ts`
  - `src/demo/demo.controller.ts`, `src/demo/demo.module.ts`
  - `test/demo/demo.int-spec.ts`
- Modify:
  - `src/config/config.ts`, `src/config/config.spec.ts` (`DEMO`, `NODE_ENV`)
  - `src/agent/agent.module.ts`, `src/inbound/inbound.module.ts`, `src/mail/mail.module.ts`
  - `src/app.module.ts`
  - `test/fakes/fake-classifier.ts` (re-export the keyword classifier), `test/fakes/fake-mail.ts` (re-export `replyPayload` from `src/demo/reply-payload.ts`)

**Interfaces:**
- Produces:
  - `DemoLlmClient implements LlmClient`. It is deterministic:
    - turn 1: amount > limit gives `request_approval`, otherwise `record_decision APPROVED`;
    - after a tool_result carrying a human decision, `record_decision` with that decision;
    - after the `record_decision` result, `end_turn`.
  - `KeywordClassifier implements ReplyClassifier` (moved from `FakeClassifier`, same regexes);
  - `DemoMailProvider implements MailProvider`: `send`/`reply` stay in memory and log, and `parseInbound` delegates to `AgentMailProvider` (real svix);
  - `GET /demo/outbox → { sent: { to; subject; threadId; messageId }[] }`, registered only when `DEMO=true`;
  - `replyPayload(p)`, the same shape as today's test helper.

- [ ] **Step 1: Write failing tests**

`src/config/config.spec.ts`:
```ts
it('rejects DEMO=true in production', () => {
  expect(() =>
    loadConfig({ DATABASE_URL: 'postgresql://x', DEMO: 'true', NODE_ENV: 'production', AGENTMAIL_WEBHOOK_SECRET: 'whsec_x' }),
  ).toThrow(/DEMO/);
});
it('requires AGENTMAIL_WEBHOOK_SECRET in DEMO', () => {
  expect(() => loadConfig({ DATABASE_URL: 'postgresql://x', DEMO: 'true' })).toThrow(/AGENTMAIL_WEBHOOK_SECRET/);
});
```

`src/demo/demo-llm.spec.ts`:
```ts
import { buildInitialMessage } from '../agent/prompts';
import { loadConfig } from '../config/config';
import { DemoLlmClient } from './demo-llm';

const cfg = loadConfig({ DATABASE_URL: 'postgresql://x' });
const input = (amountCents: number) => ({
  description: 'd', amountCents, category: 'TRAVEL' as const,
  requesterEmail: 'a@x.test', approverEmail: 'g@x.test',
});

it('asks for approval above the limit', async () => {
  const m = await new DemoLlmClient(cfg).createMessage({
    system: '', tools: [], messages: [{ role: 'user', content: buildInitialMessage(input(84000)) }],
  });
  expect(m.content[0]).toMatchObject({ type: 'tool_use', name: 'request_approval' });
});
it('approves alone at or below the limit', async () => {
  const m = await new DemoLlmClient(cfg).createMessage({
    system: '', tools: [], messages: [{ role: 'user', content: buildInitialMessage(input(50000)) }],
  });
  expect(m.content[0]).toMatchObject({ type: 'tool_use', name: 'record_decision', input: { decision: 'APPROVED' } });
});
it('records the human decision after the approval result', async () => {
  const m = await new DemoLlmClient(cfg).createMessage({
    system: '', tools: [],
    messages: [
      { role: 'user', content: buildInitialMessage(input(84000)) },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'request_approval', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"decision":"REJECTED","note":"sem nota"}' }] },
    ],
  });
  expect(m.content[0]).toMatchObject({ type: 'tool_use', name: 'record_decision', input: { decision: 'REJECTED' } });
});
it('ends the turn after record_decision', async () => {
  const m = await new DemoLlmClient(cfg).createMessage({
    system: '', tools: [],
    messages: [
      { role: 'user', content: buildInitialMessage(input(100)) },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'record_decision', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }] },
    ],
  });
  expect(m.stop_reason).toBe('end_turn');
});
```

`test/demo/demo.int-spec.ts` covers an end-to-end demo flow with the real svix signature:
```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Webhook } from 'svix';
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../../src/demo/reply-payload';
import { WorkerService } from '../../src/worker/worker.service';
import { OutboxService } from '../../src/mail/outbox.service';
import { InboundProcessor } from '../../src/inbound/inbound.processor';
import { createTestApp } from '../helpers/app';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

const SECRET = `whsec_${Buffer.from('mailgate-demo-secret-0123456789').toString('base64')}`;

describe('DEMO mode', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  beforeAll(async () => {
    process.env.DEMO = 'true';
    process.env.AGENTMAIL_WEBHOOK_SECRET = SECRET;
    prisma = newPrisma();
    app = await createTestApp();
  });
  afterAll(async () => {
    delete process.env.DEMO;
    delete process.env.AGENTMAIL_WEBHOOK_SECRET;
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(() => truncateAll(prisma));

  it('runs the whole approval flow with fakes and a real signed webhook', async () => {
    const http = request(app.getHttpServer());
    const { body } = await http.post('/runs').send(validInput({ amountCents: 84000 })).expect(201);
    await app.get(WorkerService).processNextRun();
    await app.get(OutboxService).dispatch();

    const outbox = await http.get('/demo/outbox').expect(200);
    const sent = outbox.body.sent[0];
    const payload = JSON.stringify(
      replyPayload({ threadId: sent.threadId, from: 'gestor@acme.test', text: 'pode aprovar', subject: `Re: ${sent.subject}` }),
    );
    const msgId = 'msg_demo_1';
    const now = new Date();
    const signature = new Webhook(SECRET).sign(msgId, now, payload);
    await http
      .post('/webhooks/mail')
      .set('content-type', 'application/json')
      .set('svix-id', msgId)
      .set('svix-timestamp', String(Math.floor(now.getTime() / 1000)))
      .set('svix-signature', signature)
      .send(payload)
      .expect(200);

    await app.get(InboundProcessor).processNext();
    await app.get(WorkerService).processNextRun();
    const run = await http.get(`/runs/${body.id}`).expect(200);
    expect(run.body.status).toBe('COMPLETED');
    expect(run.body.action.type).toBe('REIMBURSEMENT_APPROVED');
  });

  it('rejects a webhook with a bad signature even in DEMO', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/mail')
      .set('content-type', 'application/json')
      .set('svix-id', 'x').set('svix-timestamp', '0').set('svix-signature', 'v1,bad')
      .send('{}')
      .expect(401);
  });
});
```
`createTestApp` sets `WORKER_ENABLED=false`, and `ConfigModule` reads `process.env` at compile time, so `DEMO` must be set before `createTestApp()`. The `AppModule` import list is evaluated when the test file loads, before `beforeAll`, so a `process.env` check at module-decoration time would miss `DEMO`. Register `DemoModule` via a **dynamic module** instead: `DemoModule.register()` returns `{ module: DemoModule, controllers: loadConfig().DEMO ? [DemoController] : [] }`, evaluated at compile time.

- [ ] **Step 2: Run to verify fail**

Run:
```bash
npx jest -c jest.config.js src/config src/demo
npx jest -c jest.int.config.js --runInBand test/demo
```
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`config.ts`:
- add `DEMO: z.string().optional().transform((v) => v === 'true'),` and `NODE_ENV: z.string().optional(),`;
- add to `superRefine`:
```ts
    if (cfg.DEMO && cfg.NODE_ENV === 'production') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DEMO must not be enabled in production', path: ['DEMO'] });
    }
    if (cfg.DEMO && !cfg.AGENTMAIL_WEBHOOK_SECRET) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AGENTMAIL_WEBHOOK_SECRET is required in DEMO (replies are really signed)', path: ['AGENTMAIL_WEBHOOK_SECRET'] });
    }
```
The Dockerfile sets `NODE_ENV=production`, so a production image can never run DEMO. The record script runs the app locally with `npm run start`.

`src/demo/reply-payload.ts`: move the `replyPayload` function body from `test/fakes/fake-mail.ts` verbatim, and replace it there with `export { replyPayload } from '../../src/demo/reply-payload';`.

`src/demo/keyword-classifier.ts`: move `FakeClassifier`'s class body under the name `KeywordClassifier`, keeping the `calls` counter and `delayMs`. `test/fakes/fake-classifier.ts` becomes `export { KeywordClassifier as FakeClassifier } from '../../src/demo/keyword-classifier';`.

`src/demo/demo-llm.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config';
import type { LlmClient, LlmRequest } from '../agent/llm-client';
import { RECORD_DECISION, REQUEST_APPROVAL } from '../agent/tools';

const msg = (content: unknown[], stop_reason: Anthropic.Message['stop_reason']): Anthropic.Message =>
  ({
    id: `msg_demo_${randomUUID()}`, type: 'message', role: 'assistant', model: 'demo',
    content, stop_reason, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
  }) as unknown as Anthropic.Message;
const call = (name: string, input: Record<string, unknown>) =>
  msg([{ type: 'tool_use', id: `toolu_demo_${randomUUID()}`, name, input }], 'tool_use');

/** Deterministic agent for DEMO=true (adr 0012): same decisions a well-behaved model makes. */
export class DemoLlmClient implements LlmClient {
  constructor(private readonly cfg: AppConfig) {}

  createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    const first = req.messages[0];
    const initial = typeof first.content === 'string' ? first.content : '';
    const amount = Number(/"amountCents":\s*(\d+)/.exec(initial)?.[1] ?? 0);
    const lastAssistant = [...req.messages].reverse().find((m) => m.role === 'assistant');
    const lastTool =
      lastAssistant && typeof lastAssistant.content !== 'string'
        ? lastAssistant.content.find((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
        : undefined;
    const last = req.messages[req.messages.length - 1];
    const resultText =
      typeof last.content !== 'string'
        ? last.content
            .map((b) => (b.type === 'tool_result' && typeof b.content === 'string' ? b.content : ''))
            .join('')
        : '';

    if (!lastTool) {
      return Promise.resolve(
        amount > this.cfg.AUTO_APPROVE_LIMIT_CENTS
          ? call(REQUEST_APPROVAL, {
              summary: 'Pedido acima do limite de aprovação automática.',
              recommendation: 'APPROVE',
              rationale: 'Despesa compatível com a categoria e com a política.',
            })
          : call(RECORD_DECISION, { decision: 'APPROVED', reason: 'Dentro do limite e da política.' }),
      );
    }
    if (lastTool.name === REQUEST_APPROVAL) {
      const decision = /"decision":"REJECTED"/.test(resultText) ? 'REJECTED' : 'APPROVED';
      return Promise.resolve(call(RECORD_DECISION, { decision, reason: 'Decisão do gestor.' }));
    }
    return Promise.resolve(msg([{ type: 'text', text: 'Pronto.', citations: null }], 'end_turn'));
  }
}
```
Check the exact input keys of `request_approval` and `record_decision` in `src/agent/tools.ts` and match them. The spec above uses `summary`/`recommendation`/`rationale` and `decision`/`reason`.

`src/demo/demo-mail.provider.ts`:
```ts
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config';
import { AgentMailProvider } from '../mail/agentmail.provider';
import type { InboundEvent, MailProvider, ReplyParams, SendParams } from '../mail/mail-provider';

export interface DemoSent { to: string; subject: string; threadId: string; messageId: string }

/** Outgoing mail stays in memory; inbound is verified by the real AgentMail/svix path (adr 0012). */
export class DemoMailProvider implements MailProvider {
  private readonly logger = new Logger('DemoMail');
  private readonly inbound: AgentMailProvider;
  readonly sent: DemoSent[] = [];
  private readonly byKey = new Map<string, { messageId: string; threadId: string }>();

  constructor(cfg: AppConfig) {
    this.inbound = new AgentMailProvider(cfg);
  }

  send(p: SendParams): Promise<{ messageId: string; threadId: string }> {
    const prior = this.byKey.get(p.idempotencyKey);
    if (prior) return Promise.resolve(prior);
    const r = { messageId: `<demo-${randomUUID()}@mailgate>`, threadId: `thr_demo_${randomUUID()}` };
    this.byKey.set(p.idempotencyKey, r);
    this.sent.push({ to: p.to, subject: p.subject, ...r });
    this.logger.log(`→ ${p.to} · ${p.subject}`);
    return Promise.resolve(r);
  }

  reply(p: ReplyParams): Promise<{ messageId: string }> {
    this.logger.log(`↩ reply (${p.idempotencyKey}): ${p.text.split('\n')[0]}`);
    return Promise.resolve({ messageId: `<demo-r-${randomUUID()}@mailgate>` });
  }

  parseInbound(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): InboundEvent {
    return this.inbound.parseInbound(rawBody, headers);
  }
}
```

The factories choose by `cfg.DEMO` first:
- `mail.module.ts`: `useFactory: (cfg) => (cfg.DEMO ? new DemoMailProvider(cfg) : new AgentMailProvider(cfg))`, with `inject: [APP_CONFIG]`;
- `agent.module.ts`: `cfg.DEMO ? new DemoLlmClient(cfg) : ...` (existing chain);
- `inbound.module.ts`: `cfg.DEMO ? new KeywordClassifier() : ...`.

`src/demo/demo.controller.ts`:
```ts
import { Controller, Get, Inject } from '@nestjs/common';
import { MAIL_PROVIDER } from '../mail/mail-provider';
import type { MailProvider } from '../mail/mail-provider';
import { DemoMailProvider, DemoSent } from './demo-mail.provider';

@Controller('demo')
export class DemoController {
  constructor(@Inject(MAIL_PROVIDER) private readonly mail: MailProvider) {}
  @Get('outbox')
  outbox(): { sent: DemoSent[] } {
    return { sent: this.mail instanceof DemoMailProvider ? this.mail.sent : [] };
  }
}
```
`src/demo/demo.module.ts`:
```ts
import { DynamicModule, Module } from '@nestjs/common';
import { loadConfig } from '../config/config';
import { MailModule } from '../mail/mail.module';
import { DemoController } from './demo.controller';

@Module({})
export class DemoModule {
  /** Controllers exist only when DEMO=true (adr 0012). */
  static register(): DynamicModule {
    return { module: DemoModule, imports: [MailModule], controllers: loadConfig().DEMO ? [DemoController] : [] };
  }
}
```
Add `DemoModule.register()` to the `AppModule` imports.

`MailModule` is imported by several modules. Its providers are singletons per module class, and `DemoMailProvider` must be the same instance the outbox uses. `MailModule` is a static class module, so Nest shares one instance. Assert that in the int test: `/demo/outbox` is non-empty after `OutboxService.dispatch()`.

- [ ] **Step 4: Run**

Run:
```bash
npm test
npm run test:int
npm run lint
npm run typecheck
```
Expected: PASS. Every existing test that imports `FakeClassifier` or `replyPayload` still passes through the re-exports.

- [ ] **Step 5: Checkpoint.** Ask whether to commit (`feat(demo): DEMO mode with fakes and real webhook signature`).

### Task 15: Demo scripts and GIF recording (D013)

**Files:**
- Create:
  - `scripts/demo-reply.ts`
  - `scripts/demo-run.sh` (the terminal story that VHS types)
  - `docs/demo/terminal.tape`
  - `scripts/record-timeline.ts`
  - `scripts/record-demo.sh`
- Modify: `package.json` (devDependency `playwright` exact; script `"demo:record": "bash scripts/record-demo.sh"`), `package-lock.json` (alpine regen)
- Create (generated): `docs/assets/demo-terminal.gif`, `docs/assets/demo-timeline.gif`

**Interfaces:**
- Consumes: `GET /demo/outbox`, `POST /webhooks/mail` (svix), `GET /runs/:id` and `GET /runs/:id/timeline`.
- Produces: `npm run demo:record`, which writes the two GIFs.

- [ ] **Step 1: `scripts/demo-reply.ts`**:
```ts
/* Signs a demo reply with the svix secret and posts it (adr 0012). Usage: ts-node scripts/demo-reply.ts "pode aprovar" */
import { randomUUID } from 'node:crypto';
import { Webhook } from 'svix';
import { replyPayload } from '../src/demo/reply-payload';

async function main(): Promise<void> {
  const base = process.env.API_URL ?? 'http://localhost:3000';
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret) throw new Error('AGENTMAIL_WEBHOOK_SECRET is required');
  const text = process.argv[2] ?? 'pode aprovar';
  const from = process.env.DEMO_APPROVER ?? 'gestor@acme.test';

  const outbox = (await (await fetch(`${base}/demo/outbox`)).json()) as {
    sent: { threadId: string; subject: string }[];
  };
  const last = outbox.sent.at(-1);
  if (!last) throw new Error('no approval e-mail in the demo outbox yet');

  const body = JSON.stringify(replyPayload({ threadId: last.threadId, from, text, subject: `Re: ${last.subject}` }));
  const id = `msg_${randomUUID()}`;
  const now = new Date();
  const res = await fetch(`${base}/webhooks/mail`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
      'svix-signature': new Webhook(secret).sign(id, now, body),
    },
    body,
  });
  console.log(`reply "${text}" → ${res.status}`);
}
void main();
```

- [ ] **Step 2: `scripts/demo-run.sh`** (what the terminal GIF shows; uses `curl` + `jq`):
```bash
#!/usr/bin/env bash
set -euo pipefail
API=${API_URL:-http://localhost:3000}
echo '$ curl -X POST /runs  # R$ 840,00, acima do limite'
ID=$(curl -s -X POST "$API/runs" -H 'content-type: application/json' \
  -d '{"description":"Hotel em SP (2 diárias)","amountCents":84000,"category":"TRAVEL","requesterEmail":"ana@acme.test","approverEmail":"gestor@acme.test"}' | jq -r .id)
echo "run $ID"
sleep 3
curl -s "$API/runs/$ID" | jq '{status, approval: .approval.status}'
echo '$ # gestor responde "pode aprovar" (webhook assinado)'
npx ts-node scripts/demo-reply.ts "pode aprovar"
sleep 4
curl -s "$API/runs/$ID" | jq '{status, action: .action.type}'
echo "$ID" > /tmp/mailgate-demo-run-id
```

- [ ] **Step 3: `docs/demo/terminal.tape`**:
```
Output docs/assets/demo-terminal.gif
Set Shell "bash"
Set FontSize 18
Set Width 1000
Set Height 560
Set Theme "GitHub Dark"
Set TypingSpeed 40ms
Type "bash scripts/demo-run.sh"
Enter
Sleep 14s
```

- [ ] **Step 4: `scripts/record-timeline.ts`** (Playwright screenshots → gifski; deterministic frames):
```ts
/* Captures the timeline page while a fresh demo run goes through approval, then builds a GIF with gifski. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

async function main(): Promise<void> {
  const base = process.env.API_URL ?? 'http://localhost:3000';
  const frames = '/tmp/mailgate-timeline-frames';
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });

  const created = (await (
    await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'Hotel em SP (2 diárias)', amountCents: 84000, category: 'TRAVEL',
        requesterEmail: 'ana@acme.test', approverEmail: 'gestor@acme.test',
      }),
    })
  ).json()) as { id: string };

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 600, height: 760 } });
  let n = 0;
  const shoot = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await page.goto(`${base}/runs/${created.id}/timeline`);
      await page.screenshot({ path: `${frames}/${String(n++).padStart(4, '0')}.png` });
      await page.waitForTimeout(500);
    }
  };
  await shoot(8);
  execFileSync('npx', ['ts-node', 'scripts/demo-reply.ts', 'pode aprovar'], { stdio: 'inherit' });
  await shoot(12);
  await browser.close();

  execFileSync('bash', ['-c', `gifski --fps 2 --width 600 -o docs/assets/demo-timeline.gif ${frames}/*.png`], { stdio: 'inherit' });
}
void main();
```

- [ ] **Step 5: `scripts/record-demo.sh`**:
```bash
#!/usr/bin/env bash
# Records both README GIFs with DEMO=true (adr 0012). Needs: docker, vhs, gifski, jq, playwright chromium.
set -euo pipefail
for bin in docker vhs gifski jq; do command -v "$bin" >/dev/null || { echo "missing $bin"; exit 1; }; done
export DEMO=true WORKER_POLL_MS=200 API_URL=http://localhost:3000
export AGENTMAIL_WEBHOOK_SECRET="whsec_$(printf 'mailgate-demo-secret-0123456789' | base64)"
export DATABASE_URL=postgresql://mailgate:mailgate@localhost:5432/mailgate
docker compose up -d postgres
npx prisma migrate deploy
npm run build
node dist/main.js > /tmp/mailgate-demo.log 2>&1 &
APP=$!
trap 'kill $APP' EXIT
until curl -fsS "$API_URL/health" >/dev/null; do sleep 0.5; done
vhs docs/demo/terminal.tape
npx playwright install chromium
npx ts-node scripts/record-timeline.ts
ls -lh docs/assets/demo-*.gif
```

- [ ] **Step 6: Add the dependency and record**

Run:
```bash
npm i -DE playwright@$(npm view playwright version)
```
Regenerate the lockfile in alpine (Global Constraints), then run `npm run demo:record`.

Expected:
- both GIFs exist;
- each is ≤ 5 MB (`ls -lh`);
- the terminal GIF ends with `"status": "COMPLETED"` and `"action": "REIMBURSEMENT_APPROVED"`;
- the timeline GIF shows "Aguardando aprovação", then "Concluído".

Open both GIFs and send them to the user. If one is over 5 MB, lower `--width` or the frame count.

- [ ] **Step 7: Checkpoint.** Ask whether to commit (`feat(demo): scripted GIF recording`). Include the GIFs.

### Task 16: LICENSE, README, deploy guide, backlog closure (D014)

**Files:**
- Create: `LICENSE`, `docs/deploy.md`
- Modify:
  - `package.json` (`"license": "MIT"`)
  - `README.md`
  - `docs/00-backlog/0001`–`0010` (`state: done`) and `docs/00-backlog/README.md`

- [ ] **Step 1: `LICENSE`.** Standard MIT text, `Copyright (c) 2026 Roberto Filho`.

- [ ] **Step 2: `docs/deploy.md`** (English), with these sections:
  1. **Prerequisites:**
     - Northflank account, created **by the user**;
     - AgentMail inbox and webhook secret;
     - an LLM key.
  2. **Create the project and a PostgreSQL 16 addon.**
  3. **Service from the repo `Dockerfile`:**
     - port 3000 public HTTP;
     - start command `sh -c "npx prisma migrate deploy && node dist/main.js"`;
     - health check HTTP `GET /health`;
     - 1 instance.
  4. **Env via a secret group:**
     - `DATABASE_URL` (addon connection string; append `?sslmode=require` if refused), `DB_POOL_MAX=3`;
     - `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, optional `LLM_BASE_URL`;
     - `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET`;
     - never `DEMO`.
  5. **Register the AgentMail webhook** at `https://<service-url>/webhooks/mail`, event `message.received`.
  6. **Smoke test:**
     ```bash
     curl https://<url>/health
     ```
     Then post a R$ 840 run, reply from the approver mailbox, and watch `/runs/<id>/timeline`.
  7. **If the sandbox runs out of memory:** move to `nf-compute-20`. Plan B is Railway Hobby, with the same env and start command.

- [ ] **Step 3: README.**
  - Under the badges, add a **Demo** section with `docs/assets/demo-terminal.gif` and `docs/assets/demo-timeline.gif`, and a live URL placeholder line `Live demo: <set after deploy>`. The user fills the URL after deploying.
  - In **Quickstart**, keep ≤ 3 steps and add "Recording the demo: `npm run demo:record`", with the tool prerequisites.
  - In **Configuration**, add `SHUTDOWN_GRACE_MS`, `LLM_STRICT_OUTPUT` and `DEMO` (if not already added in Task 13).
  - In **Known limits**:
    - the timeline page is public and masks the approver e-mail (pdr 0006);
    - one high npm audit finding is accepted: `deepmerge-ts` via the Prisma CLI (adr 0011).
  - In **Deploy**, link `docs/deploy.md`.
  - In **Status**, write "F0–F6 done".
  - In **License**, write "MIT".

- [ ] **Step 4: Close backlog.** In each of `docs/00-backlog/0001`–`0010`, set `state: done`, and in the index change `open` to `done` for all ten.

- [ ] **Step 5: Verify**

Run:
```bash
npm run lint
npm run typecheck
npm test
npm run test:int
npm run test:stress
```
Expected: all PASS; stress is 20/20. Also:
```bash
grep -c "done" docs/00-backlog/README.md
```
Expected: `10`.

- [ ] **Step 6: Checkpoint.** Ask whether to commit (`docs: license, deploy guide, README demo; close backlog 0001–0010`).

- [ ] **Step 7: Hand off the deploy.** Tell the user the exact steps in `docs/deploy.md` that only they can do: create the account, enter the secrets, and register the webhook. Offer to run the smoke test against their URL once it exists.
