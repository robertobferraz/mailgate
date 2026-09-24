import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderApprovalEmail,
  renderClarificationEmail,
  renderLateReplyEmail,
} from '../src/mail/templates';
import { RunView } from '../src/runs/runs.service';
import { renderTimelinePage } from '../src/runs/timeline-page';

const out = join(__dirname, '..', 'docs', 'mocks');
mkdirSync(out, { recursive: true });

const approval = renderApprovalEmail({
  subjectToken: 'k7q2m4xa',
  description: 'Hotel em São Paulo (2 diárias) para visita ao cliente Beta',
  category: 'TRAVEL',
  amountCents: 84000,
  requesterEmail: 'ana@acme.test',
  summary:
    'Duas diárias de hotel em SP para reunião presencial com o cliente Beta, com nota fiscal anexada.',
  recommendation: 'APPROVE',
  rationale:
    'Valor dentro da média de hospedagem para a cidade e viagem justificada por reunião de contrato.',
  expiresAt: new Date('2026-09-25T17:30:00Z'),
});
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="background:#e5e7eb;padding:24px"><div style="background:#fff;padding:24px;max-width:600px;margin:auto"><p style="color:#666;font:13px monospace">Assunto: ${title}</p>${body}</div></body>`;

writeFileSync(
  join(out, 'approval.txt'),
  `Assunto: ${approval.subject}\n\n${approval.text}\n`,
);
writeFileSync(
  join(out, 'approval.html'),
  page(approval.subject, approval.html),
);
const clar = renderClarificationEmail();
writeFileSync(join(out, 'clarification.txt'), `${clar.text}\n`);
writeFileSync(
  join(out, 'clarification.html'),
  page('Re: [mailgate #k7q2m4xa] …', clar.html),
);
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
const runId = 'a1a2a3a4-b1b2-4c1c-8d1d-e1e2e3e4e5e6';
const runInput = {
  description: 'Hotel em São Paulo (2 diárias) para visita ao cliente Beta',
  amountCents: 84000,
  category: 'TRAVEL' as const,
  requesterEmail: 'ana@acme.test',
  approverEmail: 'gestor@acme.test',
};

const timelineWaiting: RunView = {
  id: runId,
  status: 'WAITING_APPROVAL',
  input: runInput,
  attempts: 1,
  lastError: null,
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
      at: new Date('2026-09-23T12:00:04Z'),
      type: 'CLAIMED',
      data: { attempts: 1 },
    },
    {
      at: new Date('2026-09-23T12:00:12Z'),
      type: 'APPROVAL_REQUESTED',
      data: {},
    },
    {
      at: new Date('2026-09-23T12:00:15Z'),
      type: 'APPROVAL_SENT',
      data: {},
    },
  ],
};
writeFileSync(
  join(out, 'timeline-waiting.html'),
  renderTimelinePage(timelineWaiting),
);

const timelineCompleted: RunView = {
  id: runId,
  status: 'COMPLETED',
  input: runInput,
  attempts: 1,
  lastError: null,
  approval: {
    status: 'DECIDED',
    decision: 'APPROVED',
    note: 'Pode aprovar, reunião confirmada.',
    expiresAt: new Date('2026-09-25T17:30:00Z'),
  },
  action: {
    type: 'REIMBURSEMENT_APPROVED',
    payload: {},
    createdAt: new Date('2026-09-23T18:05:03Z'),
  },
  timeline: [
    ...timelineWaiting.timeline,
    {
      at: new Date('2026-09-23T18:05:00Z'),
      type: 'DECISION_RECEIVED',
      data: { decision: 'APPROVED', from: 'gestor@acme.test' },
    },
    {
      at: new Date('2026-09-23T18:05:02Z'),
      type: 'RESUMED',
      data: {},
    },
    {
      at: new Date('2026-09-23T18:05:03Z'),
      type: 'ACTION_RECORDED',
      data: { decision: 'APPROVED' },
    },
    {
      at: new Date('2026-09-23T18:05:04Z'),
      type: 'COMPLETED',
      data: {},
    },
  ],
};
writeFileSync(
  join(out, 'timeline-completed.html'),
  renderTimelinePage(timelineCompleted),
);

console.log(`mocks written to ${out}`);
