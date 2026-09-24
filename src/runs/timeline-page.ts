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
import { RunEventType } from './run-events';
import { Run } from './run';
import { RunView } from './runs.service';

export const TERMINAL_STATUSES: ReadonlySet<Run['status']> = new Set<
  Run['status']
>(['COMPLETED', 'FAILED', 'EXPIRED']);

const STATUS_LABEL: Record<Run['status'], string> = {
  PENDING: 'Na fila',
  RUNNING: 'Em análise',
  WAITING_APPROVAL: 'Aguardando aprovação',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  EXPIRED: 'Expirado',
};

const EVENT_LABEL: Record<RunEventType, string> = {
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
const num = (v: unknown) => (typeof v === 'number' ? String(v) : '');

/** The view carries event/status as plain strings; look up the typed label maps without letting an unknown value crash. */
const eventLabel = (type: string): string =>
  EVENT_LABEL[type as RunEventType] ?? type;
const statusLabel = (status: Run['status']): string =>
  STATUS_LABEL[status] ?? status;

function eventDetail(type: string, data: Data): string {
  switch (type) {
    case 'DECISION_RECEIVED': {
      const decision = DECISION_LABEL[str(data.decision)] ?? '';
      const from = str(data.from);
      const masked = from ? maskEmail(from) : '';
      if (!masked) return decision;
      return decision ? `${decision} por ${masked}` : `por ${masked}`;
    }
    case 'ACTION_RECORDED':
      return DECISION_LABEL[str(data.decision)] ?? '';
    case 'RETRY_SCHEDULED':
      return 'erro transitório';
    case 'FAILED':
      return 'erro permanente';
    case 'CLAIMED': {
      const attempts = num(data.attempts);
      return attempts ? `tentativa ${attempts}` : '';
    }
    default:
      return '';
  }
}

const DANGER = '#b42318'; // failed state only, ~6.5:1 on white

type Tone = 'accent' | 'ink' | 'danger' | 'muted';

/** Colour of the run's "current" marker: accent while in flight, then one neutral/danger colour per terminal state. */
const statusTone = (status: Run['status']): Tone =>
  status === 'COMPLETED'
    ? 'ink'
    : status === 'FAILED'
      ? 'danger'
      : status === 'EXPIRED'
        ? 'muted'
        : 'accent';

// Served with CSP style-src 'unsafe-inline': one <style> block, no JS, no external assets.
const CSS = [
  `body{margin:0;background:#ffffff;color:${INK};font-family:${FONT};font-size:15px;line-height:1.6}`,
  `main{max-width:600px;margin:0 auto;padding:32px 20px 48px}`,
  `.top{margin:0;color:${MUTED};font-size:13px}`,
  `h1{margin:4px 0 0;font-size:22px;line-height:1.3;font-weight:700}`,
  `.sdot{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;margin-right:10px;position:relative;top:-2px}`,
  `.live{margin:4px 0 0;color:${MUTED};font-size:13px}`,
  `.pulse{animation:pulse 1.6s ease-in-out infinite}`,
  `@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}`,
  `@media (prefers-reduced-motion:reduce){.pulse{animation:none}}`,
  `.summary{margin-top:24px}`,
  `.amount{background:${ACCENT_TINT};border-radius:8px;padding:14px 16px}`,
  `.label{display:block;font-size:12px;color:${MUTED}}`,
  `.value{display:block;font-size:26px;line-height:1.3;font-weight:700;color:${ACCENT};padding-top:2px}`,
  `.desc{margin:16px 0 0;font-size:16px}`,
  `dl{display:grid;grid-template-columns:120px 1fr;column-gap:12px;row-gap:6px;margin:16px 0 0}`,
  `dt{color:${MUTED}}`,
  `dd{margin:0;font-weight:600}`,
  `@media (max-width:419px){dl{grid-template-columns:1fr;row-gap:0}dd{margin-bottom:6px}}`,
  `.note{margin-top:16px;border:1px solid ${RULE};border-radius:8px;padding:12px 16px}`,
  `.timeline{margin-top:32px}`,
  `h2{margin:0 0 12px;font-size:15px;font-weight:700}`,
  `ol{list-style:none;margin:0;padding:0}`,
  `.day{color:${MUTED};font-size:13px;margin:0 0 6px}`,
  `.ev+.day{margin-top:14px}`,
  `.ev{display:grid;grid-template-columns:48px 20px 1fr}`,
  `.time{color:${MUTED};font-size:13px;font-variant-numeric:tabular-nums;padding-top:2px}`,
  `.rail{position:relative}`,
  `.rail::before{content:"";position:absolute;left:50%;top:0;bottom:0;width:1px;margin-left:-0.5px;background:${RULE}}`,
  `.first .rail::before{top:12px}`,
  `.last .rail::before{bottom:calc(100% - 12px)}`,
  `.dot{position:absolute;left:50%;top:12px;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;box-sizing:border-box}`,
  `.body{padding:0 0 14px 4px}`,
  `.last .body{padding-bottom:0}`,
  `.detail,.next{color:${MUTED}}`,
  `.t-accent{background:${ACCENT}}`,
  `.t-ink{background:${INK}}`,
  `.t-danger{background:${DANGER}}`,
  `.t-muted{background:${MUTED}}`,
  `.t-next{background:#ffffff;border:2px solid ${ACCENT}}`,
].join('');

interface Row {
  day: string;
  time: string;
  tone: Tone | 'next';
  body: string; // already-escaped HTML
}

/** "23/09/2026, 09:00" -> ["23/09/2026", "09:00"]. */
function splitWhen(d: Date): [string, string] {
  const s = formatDeadline(d);
  const i = s.indexOf(', ');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 2)];
}

function renderRows(rows: Row[]): string {
  return rows
    .map((r, i) => {
      const newDay = i === 0 || rows[i - 1].day !== r.day;
      const lastOfDay = i === rows.length - 1 || rows[i + 1].day !== r.day;
      const cls = ['ev', newDay ? 'first' : '', lastOfDay ? 'last' : '']
        .filter(Boolean)
        .join(' ');
      const day = newDay
        ? `<li class="day" role="presentation">${escapeHtml(r.day)}</li>`
        : '';
      return `${day}<li class="${cls}"><span class="time">${escapeHtml(r.time)}</span><span class="rail"><span class="dot t-${r.tone}"></span></span><div class="body">${r.body}</div></li>`;
    })
    .join('');
}

export function renderTimelinePage(v: RunView): string {
  const terminal = TERMINAL_STATUSES.has(v.status);
  const refresh = terminal ? '' : '<meta http-equiv="refresh" content="2">';
  const tone = statusTone(v.status);
  const amount = formatBRL(v.input.amountCents);
  const errorClass = v.lastError
    ? v.status === 'FAILED'
      ? 'permanente'
      : 'transitório'
    : null;
  const approver = escapeHtml(maskEmail(v.input.approverEmail));

  const header = `<p class="top">mailgate · run ${escapeHtml(v.id.slice(0, 8))}</p><h1><span class="sdot t-${tone}${terminal ? '' : ' pulse'}"></span>${escapeHtml(statusLabel(v.status))}</h1>${terminal ? '' : '<p class="live">Atualiza sozinha a cada 2 segundos</p>'}`;

  const facts: [string, string][] = [
    ['Categoria', escapeHtml(CATEGORY_LABEL[v.input.category])],
    [
      'Tentativas',
      `${v.attempts}${errorClass ? ` · último erro: ${errorClass}` : ''}`,
    ],
  ];
  if (v.approval) {
    facts.push(['Aprovador', approver]);
    facts.push([
      'Prazo',
      `${escapeHtml(formatDeadline(v.approval.expiresAt))} (horário de Brasília)`,
    ]);
    if (v.approval.decision) {
      facts.push([
        'Decisão',
        escapeHtml(DECISION_LABEL[v.approval.decision] ?? v.approval.decision),
      ]);
    }
  }
  const dl = `<dl>${facts.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>`;
  const note = v.approval?.note
    ? `<div class="note"><span class="label">Comentário do aprovador</span>${escapeHtml(v.approval.note)}</div>`
    : '';
  const summary = `<section class="summary"><div class="amount"><span class="label">Valor</span><span class="value">${escapeHtml(amount)}</span></div><p class="desc">${escapeHtml(v.input.description)}</p>${dl}${note}</section>`;

  const rows: Row[] = v.timeline.map((e, i) => {
    const [day, time] = splitWhen(e.at);
    const detail = eventDetail(e.type, (e.data ?? {}) as Data);
    return {
      day,
      time,
      tone: i === v.timeline.length - 1 ? tone : 'muted',
      body: `<strong>${escapeHtml(eventLabel(e.type))}</strong>${detail ? ` <span class="detail">· ${escapeHtml(detail)}</span>` : ''}`,
    };
  });
  if (v.status === 'WAITING_APPROVAL' && v.approval && rows.length > 0) {
    rows.push({
      day: rows[rows.length - 1].day,
      time: '',
      tone: 'next',
      body: `<span class="next">Aguardando resposta de ${approver} até ${escapeHtml(formatDeadline(v.approval.expiresAt))}</span>`,
    });
  }
  const timeline = rows.length
    ? `<section class="timeline"><h2>Linha do tempo</h2><ol>${renderRows(rows)}</ol></section>`
    : '';

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>mailgate · ${escapeHtml(statusLabel(v.status))}</title><style>${CSS}</style></head><body><main>${header}${summary}${timeline}</main></body></html>`;
}
