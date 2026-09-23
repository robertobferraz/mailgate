import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderApprovalEmail,
  renderClarificationEmail,
} from '../src/mail/templates';

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
console.log(`mocks written to ${out}`);
