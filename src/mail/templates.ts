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

const INSTRUCTION =
  'Responda este e-mail com APROVO ou RECUSO (pode incluir um comentário).';
const CLARIFICATION =
  'Não consegui entender sua resposta. Responda apenas APROVO ou RECUSO.';

// E-mail-safe design tokens: inline styles only, no external CSS/fonts.
// Restrained palette (PRODUCT.md): near-black ink, one functional accent
// reserved for the amount and the reply instruction, muted secondary text
// that still clears WCAG AA (>=4.5:1) on both white and the accent tint.
const FONT =
  "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#1a1a1a'; // primary text, ~17.5:1 on white
const MUTED = '#55606e'; // secondary text (labels, footer, deadline), ~6.4:1 on white
const ACCENT = '#1d4ed8'; // functional accent: amount + reply instruction, ~6.7:1 on white
const ACCENT_TINT = '#eef2ff'; // pale background for accent blocks
const RULE = '#e5e7eb'; // hairline divider

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
