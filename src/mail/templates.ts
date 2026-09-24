import { CATEGORY_LABEL, Category } from '../runs/reimbursement-input';
import { formatBRL, formatDeadline } from './format';
import {
  ACCENT,
  ACCENT_TINT,
  FONT,
  INK,
  MUTED,
  RULE,
  escapeHtml,
} from '../shared/html';

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

const INSTRUCTION =
  'Responda este e-mail com APROVO ou RECUSO (pode incluir um comentário).';
const CLARIFICATION =
  'Não consegui entender sua resposta. Responda apenas APROVO ou RECUSO.';

/** Hidden inbox-preview snippet (inbox list only; invisible once the e-mail is open). */
function preheader(text: string): string {
  const pad = '&nbsp;&zwnj;'.repeat(20);
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${ACCENT_TINT}">${escapeHtml(text)}${pad}</div>`;
}

/** Shared table-based shell (Outlook/Gmail-safe), max ~560px, same look for both e-mails in a thread. */
function shell(bodyRows: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff"><tr><td align="center" style="padding:24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK}">${bodyRows}</table></td></tr></table>`;
}

function footerRow(): string {
  return `<tr><td style="padding-top:24px"><div style="border-top:1px solid ${RULE};padding-top:16px;font-size:13px;color:${MUTED}">— mailgate</div></td></tr>`;
}

/** The one number the approver must not miss: pulled out of the field list, given its own weight. */
function amountBlock(label: string, amount: string): string {
  return `<tr><td style="padding-top:20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${ACCENT_TINT};border-radius:8px"><tr><td style="padding:14px 16px"><span style="display:block;font-size:12px;color:${MUTED}">${escapeHtml(label)}</span><span style="display:block;font-size:26px;line-height:1.3;font-weight:700;color:${ACCENT};padding-top:2px">${escapeHtml(amount)}</span></td></tr></table></td></tr>`;
}

function detailsRow(label: string, value: string): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:${MUTED};vertical-align:top;width:120px">${label}</td><td style="padding:4px 0"><strong>${escapeHtml(value)}</strong></td></tr>`;
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

  const details = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">${detailsRow('Descrição', d.description)}${detailsRow('Categoria', CATEGORY_LABEL[d.category])}${detailsRow('Solicitante', d.requesterEmail)}</table>`;

  const html = shell(
    [
      preheader(`${amount} — ${d.description}`),
      `<tr><td>Olá,<br>Um pedido de reembolso precisa da sua aprovação.</td></tr>`,
      amountBlock('Valor', amount),
      `<tr><td style="padding-top:20px">${details}</td></tr>`,
      `<tr><td style="padding-top:20px"><strong>Resumo do agente</strong><br>${escapeHtml(d.summary)}</td></tr>`,
      `<tr><td style="padding-top:16px"><strong>Recomendação do agente: ${rec}</strong><br>${escapeHtml(d.rationale)}</td></tr>`,
      `<tr><td style="padding-top:20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${ACCENT_TINT};border-radius:8px"><tr><td style="padding:14px 16px"><strong style="color:${ACCENT}">${INSTRUCTION}</strong></td></tr></table></td></tr>`,
      `<tr><td style="padding-top:12px;font-size:13px;color:${MUTED}">Prazo para resposta: ${escapeHtml(due)} (horário de Brasília). Sem resposta até lá, o pedido expira.</td></tr>`,
      footerRow(),
    ].join(''),
  );

  return { subject, text, html };
}

export function renderClarificationEmail(): { text: string; html: string } {
  const html = shell(
    [
      preheader(CLARIFICATION),
      `<tr><td><strong>${CLARIFICATION}</strong></td></tr>`,
      footerRow(),
    ].join(''),
  );

  return {
    text: `${CLARIFICATION}\n\n— mailgate`,
    html,
  };
}

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
  const text = [...lines, ...(note ? ['', note] : []), '', '— mailgate'].join(
    '\n',
  );
  const status = d.state === 'EXPIRED' ? 'EXPIRADO' : LATE_LABEL[d.state];
  const whenLabel = d.state === 'EXPIRED' ? 'Expirou em' : 'Decidido em';
  const html = shell(
    [
      preheader(lines[0]),
      statusBlock('Situação do pedido', status),
      `<tr><td style="padding-top:20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">${detailsRow(whenLabel, `${when} (horário de Brasília)`)}</table></td></tr>`,
      `<tr><td style="padding-top:20px">${escapeHtml(lines[0])}<br>${escapeHtml(lines[1])}</td></tr>`,
      d.note ? noteBlock('Comentário registrado', d.note) : '',
      footerRow(),
    ].join(''),
  );
  return { text, html };
}

/** First row of the late reply. Same vocabulary as amountBlock, but the value stays in ink: the accent is reserved for amount + reply instruction. */
function statusBlock(label: string, value: string): string {
  return `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${ACCENT_TINT};border-radius:8px"><tr><td style="padding:14px 16px"><span style="display:block;font-size:12px;color:${MUTED}">${escapeHtml(label)}</span><span style="display:block;font-size:20px;line-height:1.3;font-weight:700;color:${INK};padding-top:2px">${escapeHtml(value)}</span></td></tr></table></td></tr>`;
}

function noteBlock(label: string, note: string): string {
  return `<tr><td style="padding-top:20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid ${RULE};border-radius:8px;border-collapse:separate"><tr><td style="padding:12px 16px"><span style="display:block;font-size:12px;color:${MUTED}">${escapeHtml(label)}</span><span style="display:block;color:${INK}">${escapeHtml(note)}</span></td></tr></table></td></tr>`;
}
