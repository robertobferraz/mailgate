import { recordDecisionInput, requestApprovalInput, TOOLS } from './tools';
import { buildInitialMessage, buildSystemPrompt } from './prompts';

describe('tools', () => {
  it('declares both tools as strict objects without extra properties', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'request_approval',
      'record_decision',
    ]);
    for (const t of TOOLS) {
      expect((t as { strict?: boolean }).strict).toBe(true);
      expect(t.input_schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
  });
  it('validates inputs', () => {
    expect(
      recordDecisionInput.safeParse({ decision: 'APPROVED', reason: 'ok' })
        .success,
    ).toBe(true);
    expect(
      recordDecisionInput.safeParse({ decision: 'MAYBE', reason: 'ok' })
        .success,
    ).toBe(false);
    expect(
      requestApprovalInput.safeParse({
        summary: 's',
        recommendation: 'APPROVE',
        rationale: 'r',
      }).success,
    ).toBe(true);
  });
});

describe('prompts', () => {
  it('states the limit in BRL and the approval rule', () => {
    const p = buildSystemPrompt(50000);
    expect(p).toContain('R$ 500,00');
    expect(p).toContain('request_approval');
    expect(buildSystemPrompt(50000)).toBe(p); // stable, cache-friendly
  });
  it('renders the request with the formatted amount', () => {
    expect(
      buildInitialMessage({
        description: 'd',
        amountCents: 84000,
        category: 'TRAVEL',
        requesterEmail: 'a@x.t',
        approverEmail: 'g@x.t',
      }),
    ).toContain('R$ 840,00');
  });
});
