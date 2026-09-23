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
    expect(
      reimbursementInputSchema.safeParse({ ...valid, ...patch }).success,
    ).toBe(false);
  });
});
