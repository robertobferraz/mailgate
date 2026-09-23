import { Webhook } from 'svix';
import { loadConfig } from '../config/config';
import { AgentMailProvider } from './agentmail.provider';
import {
  extractAddress,
  InvalidSignatureError,
  toInboundEvent,
} from './mail-provider';

const SECRET = `whsec_${Buffer.from('mailgate-test-secret-0123456789').toString('base64')}`;

const received = {
  event_type: 'message.received',
  event_id: 'evt_1',
  message: {
    message_id: '<m2@agentmail.to>',
    thread_id: 'thr_1',
    from: 'Gestor <GESTOR@ACME.TEST>',
    subject: 'Re: [mailgate #abcd2345] Reembolso',
    text: 'pode aprovar\n\n> citado',
    extracted_text: 'pode aprovar',
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
      eventId: 'msg_svix_1',
      type: 'message.received',
      threadId: 'thr_1',
      messageId: '<m2@agentmail.to>',
      from: 'gestor@acme.test',
      subject: 'Re: [mailgate #abcd2345] Reembolso',
      text: 'pode aprovar',
      raw: received,
    });
  });
  it('falls back to text and tolerates a missing thread id', () => {
    const e = toInboundEvent('x', {
      event_type: 'message.received',
      message: { message_id: 'm', from: 'a@b.c', subject: 's', text: 'aprovo' },
    });
    expect(e.threadId).toBeNull();
    expect(e.text).toBe('aprovo');
  });
});

describe('AgentMailProvider.parseInbound', () => {
  const provider = new AgentMailProvider(
    loadConfig({
      DATABASE_URL: 'postgresql://x',
      AGENTMAIL_WEBHOOK_SECRET: SECRET,
      AGENTMAIL_API_KEY: 'k',
      AGENTMAIL_INBOX_ID: 'i',
    }),
  );
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
    expect(provider.parseInbound(Buffer.from(body), signed(body)).eventId).toBe(
      'msg_svix_1',
    );
  });
  it('rejects a tampered body', () => {
    expect(() =>
      provider.parseInbound(
        Buffer.from(body.replace('aprovar', 'recusar')),
        signed(body),
      ),
    ).toThrow(InvalidSignatureError);
  });
  it('rejects missing headers', () => {
    expect(() => provider.parseInbound(Buffer.from(body), {})).toThrow(
      InvalidSignatureError,
    );
  });

  it('normalizes a real-shaped AgentMail webhook payload (svix Webhook.verify does not return the parsed body)', () => {
    const realShaped = {
      event_id: 'evt_fake_1',
      event_type: 'message.received',
      type: 'event',
      message: {
        authentication_results: { dkim: 'pass', dmarc: 'pass', spf: 'pass' },
        created_at: '2026-09-23T22:17:22.454Z',
        extracted_html: '<html><body>pode aprovar</body></html>',
        extracted_text: 'pode aprovar',
        from: 'Gestor <gestor@acme.test>',
        from_: 'Gestor <gestor@acme.test>',
        headers: {},
        html: '<html><body>pode aprovar</body></html>',
        in_reply_to: '<orig@acme.test>',
        inbox_id: 'inbox-fake@agentmail.to',
        labels: ['received', 'unread'],
        message_id: '<real-shaped-msg@acme.test>',
        organization_id: 'org-fake-1',
        pod_id: 'org-fake-1',
        preview: 'pode aprovar',
        references: ['<orig@acme.test>'],
        size: 1234,
        smtp_id: 'smtp-fake-1',
        subject: 'RE: [mailgate #fake1234] Reembolso de R$ 100,00',
        text: 'pode aprovar\n\n> citado',
        thread_id: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-09-23T22:17:20.000Z',
        to: ['AgentMail <inbox-fake@agentmail.to>'],
        updated_at: '2026-09-23T22:17:22.454Z',
      },
      thread: {
        created_at: '2026-09-23T22:16:34.081Z',
        inbox_id: 'inbox-fake@agentmail.to',
        labels: ['sent', 'received', 'unread'],
        last_message_id: '<real-shaped-msg@acme.test>',
        message_count: 2,
        organization_id: 'org-fake-1',
        pod_id: 'org-fake-1',
        preview: 'pode aprovar',
        received_timestamp: '2026-09-23T22:17:20.000Z',
        recipients: ['inbox-fake@agentmail.to'],
        senders: ['gestor@acme.test'],
        sent_timestamp: '2026-09-23T22:16:34.081Z',
        size: 4321,
        thread_id: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-09-23T22:17:20.000Z',
        updated_at: '2026-09-23T22:17:22.454Z',
      },
    };
    const payload = JSON.stringify(realShaped);
    const event = provider.parseInbound(
      Buffer.from(payload),
      signed(payload, 'msg_svix_real_shaped'),
    );
    expect(event).toEqual({
      eventId: 'msg_svix_real_shaped',
      type: 'message.received',
      threadId: '11111111-1111-4111-8111-111111111111',
      messageId: '<real-shaped-msg@acme.test>',
      from: 'gestor@acme.test',
      subject: 'RE: [mailgate #fake1234] Reembolso de R$ 100,00',
      text: 'pode aprovar',
      raw: realShaped,
    });
  });
});
