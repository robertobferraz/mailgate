import {
  renderApprovalEmail,
  renderClarificationEmail,
  SUBJECT_TOKEN_RE,
} from './templates';

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
    expect(e.subject).toBe(
      '[mailgate #abcd2345] Reembolso de R$ 840,00 — aprovação necessária',
    );
    expect(SUBJECT_TOKEN_RE.exec(e.subject)?.[1]).toBe('abcd2345');
  });
  it('includes every required field in the text body', () => {
    for (const s of [
      'Hotel <b>SP</b>',
      'Viagem',
      'R$ 840,00',
      'ana@acme.test',
      data.summary,
      'APROVAR',
      data.rationale,
      'Responda este e-mail com APROVO ou RECUSO (pode incluir um comentário).',
      '25/09/2026',
    ]) {
      expect(e.text).toContain(s);
    }
  });
  it('escapes user content in HTML', () => {
    expect(e.html).toContain('Hotel &lt;b&gt;SP&lt;/b&gt;');
    expect(e.html).not.toContain('<b>SP</b>');
  });
  it('renders REJECT as RECUSAR', () => {
    expect(
      renderApprovalEmail({ ...data, recommendation: 'REJECT' }).text,
    ).toContain('Recomendação do agente: RECUSAR');
  });
  it('includes a hidden inbox-preview snippet with the amount, escaped', () => {
    expect(e.html).toContain('mso-hide:all');
    expect(e.html).toContain('R$ 840,00 — Hotel &lt;b&gt;SP&lt;/b&gt;');
  });
});

describe('renderClarificationEmail', () => {
  it('asks for APROVO or RECUSO only', () => {
    expect(renderClarificationEmail().text).toContain(
      'Não consegui entender sua resposta. Responda apenas APROVO ou RECUSO.',
    );
  });
  it('uses the same table-based shell as the approval e-mail', () => {
    const approvalHtml = renderApprovalEmail(data).html;
    const clarificationHtml = renderClarificationEmail().html;
    expect(clarificationHtml).toContain('role="presentation"');
    expect(clarificationHtml).toContain('mso-hide:all');
    // same font stack and footer sign-off in both e-mails of the thread
    const font = approvalHtml.match(/font-family:([^;"]+)/)?.[1];
    expect(font).toBeTruthy();
    expect(clarificationHtml).toContain(`font-family:${font}`);
    expect(clarificationHtml).toContain('— mailgate');
  });
});
