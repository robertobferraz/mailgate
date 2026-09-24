import { formatBRL } from '../mail/format';
import { escapeHtml } from '../shared/html';
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
    expect(html).toContain(
      '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &quot;SP&quot;',
    );
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
      expect(renderTimelinePage(base({ status }))).not.toContain(
        'http-equiv="refresh"',
      );
    },
  );
  it('labels a FAILED run error as permanente', () => {
    expect(renderTimelinePage(base({ status: 'FAILED' }))).toContain(
      'permanente',
    );
  });
  it('shows the amount and events in Portuguese', () => {
    const html = renderTimelinePage(base());
    expect(html).toContain(escapeHtml(formatBRL(84000)));
    expect(html).toContain('Pedido criado');
    expect(html).toContain('Decisão recebida');
  });
  it('escapes an approval note containing markup', () => {
    const html = renderTimelinePage(
      base({
        approval: {
          status: 'SENT',
          decision: null,
          note: `<b>'x'</b>`,
          expiresAt: new Date('2026-09-25T17:30:00Z'),
        },
      }),
    );
    expect(html).toContain('&lt;b&gt;&#39;x&#39;&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });
  it('omits "Aprovador" when approval is null', () => {
    const html = renderTimelinePage(base({ approval: null }));
    expect(html).not.toContain('Aprovador');
  });
  it('renders the status header and no list items for an empty timeline', () => {
    const html = renderTimelinePage(base({ timeline: [] }));
    expect(html).toContain('Aguardando aprovação');
    expect(html).not.toContain('<li');
  });
  it('omits "último erro" when lastError is null', () => {
    const html = renderTimelinePage(base({ lastError: null }));
    expect(html).not.toContain('último erro');
  });
  it('renders "por g***@..." without a leading space when the decision is missing', () => {
    const html = renderTimelinePage(
      base({
        timeline: [
          {
            at: new Date('2026-09-23T12:00:05Z'),
            type: 'DECISION_RECEIVED',
            data: { from: 'gestor@acme.test' },
          },
        ],
      }),
    );
    expect(html).toContain('· por g***@acme.test<');
    expect(html).not.toContain('·  por');
  });
  it('renders "por g***@..." without a leading space when the decision is unknown', () => {
    const html = renderTimelinePage(
      base({
        timeline: [
          {
            at: new Date('2026-09-23T12:00:05Z'),
            type: 'DECISION_RECEIVED',
            data: { decision: 'SOMETHING_ELSE', from: 'gestor@acme.test' },
          },
        ],
      }),
    );
    expect(html).toContain('· por g***@acme.test<');
    expect(html).not.toContain('·  por');
  });
  it('renders nothing for a DECISION_RECEIVED event missing both decision and from', () => {
    const html = renderTimelinePage(
      base({
        timeline: [
          {
            at: new Date('2026-09-23T12:00:05Z'),
            type: 'DECISION_RECEIVED',
            data: {},
          },
        ],
      }),
    );
    expect(html).not.toContain('· <span');
    expect(html).not.toContain('por ***');
  });
  it('says the page refreshes itself only while the run is not terminal', () => {
    expect(renderTimelinePage(base())).toContain('Atualiza sozinha');
    expect(renderTimelinePage(base({ status: 'COMPLETED' }))).not.toContain(
      'Atualiza sozinha',
    );
  });
  it('shows the pending next step only while waiting for approval', () => {
    expect(renderTimelinePage(base())).toContain(
      'Aguardando resposta de g***@acme.test',
    );
    expect(renderTimelinePage(base({ status: 'COMPLETED' }))).not.toContain(
      'Aguardando resposta de',
    );
  });
  it('has exactly one <style> element and no script', () => {
    const html = renderTimelinePage(base());
    expect(html.split('<style>').length - 1).toBe(1);
    expect(html).not.toContain('<script');
  });
  it('renders nothing for a CLAIMED event with no numeric attempts', () => {
    const html = renderTimelinePage(
      base({
        timeline: [
          {
            at: new Date('2026-09-23T12:00:05Z'),
            type: 'CLAIMED',
            data: {},
          },
        ],
      }),
    );
    expect(html).not.toContain('tentativa ');
    expect(html).not.toContain('· <span');
  });
});
