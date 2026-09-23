import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '../../src/generated/prisma/client';
import { endTurn, stopWith, toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness } from '../helpers/harness';

const lastToolResult = (req: { messages: Anthropic.MessageParam[] }) => {
  const last = req.messages[req.messages.length - 1];
  return (last.content as Anthropic.ToolResultBlockParam[])[0];
};

describe('AgentRunner — decisions', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('approves alone at or below the limit and completes (boundary 50000)', async () => {
    const h = buildHarness(prisma, {
      script: [
        toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }),
        endTurn(),
      ],
    });
    const run = await h.runs.create(validInput({ amountCents: 50000 }));
    await h.worker.processNextRun();
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
    const action = await prisma.action.findFirstOrThrow({
      where: { runId: run.id },
    });
    expect(action.type).toBe('REIMBURSEMENT_APPROVED');
    expect(action.payload).toMatchObject({
      decidedBy: 'AGENT',
      amountCents: 50000,
    });
    const saved = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect((saved.messages as unknown[]).length).toBe(4); // user, assistant(tool_use), user(tool_result), assistant(end)
  });

  it('rejects APPROVED above the limit without human approval (is_error), no action', async () => {
    const h = buildHarness(prisma, {
      script: [
        toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }),
        endTurn(),
      ],
    });
    const run = await h.runs.create(validInput({ amountCents: 50001 }));
    await h.worker.processNextRun();
    const result = lastToolResult(h.llm.requests[1]);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toContain('request_approval');
    expect(await prisma.action.count()).toBe(0);
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({
      status: 'FAILED',
      lastError: 'agent ended without a decision',
    });
  });

  it('allows REJECTED above the limit without approval', async () => {
    const h = buildHarness(prisma, {
      script: [
        toolUse('record_decision', {
          decision: 'REJECTED',
          reason: 'sem nota',
        }),
        endTurn(),
      ],
    });
    const run = await h.runs.create(validInput({ amountCents: 900000 }));
    await h.worker.processNextRun();
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
  });

  it('refuses a second record_decision with a different tool_use id (one action only)', async () => {
    const h = buildHarness(prisma, {
      script: [
        toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }),
        toolUse('record_decision', {
          decision: 'REJECTED',
          reason: 'mudei de ideia',
        }),
        endTurn(),
      ],
    });
    const run = await h.runs.create(validInput({ amountCents: 1000 }));
    await h.worker.processNextRun();
    expect(lastToolResult(h.llm.requests[2]).is_error).toBe(true);
    expect(await prisma.action.count({ where: { runId: run.id } })).toBe(1);
    expect(
      (await prisma.action.findFirstOrThrow({ where: { runId: run.id } })).type,
    ).toBe('REIMBURSEMENT_APPROVED');
  });

  it('I1 — re-executing record_decision after a crash does not duplicate the action', async () => {
    const h = buildHarness(prisma, { script: [endTurn()] });
    const run = await h.runs.create(validInput({ amountCents: 1000 }));
    // state right after a crash: tool_use persisted, action inserted, tool_result never persisted
    const crashed = toolUse(
      'record_decision',
      { decision: 'APPROVED', reason: 'ok' },
      'toolu_crash',
    );
    await prisma.run.update({
      where: { id: run.id },
      data: {
        messages: [
          { role: 'user', content: 'pedido' },
          { role: 'assistant', content: crashed.content },
        ] as object[],
      },
    });
    await h.actions.recordIfAbsent(prisma, {
      runId: run.id,
      toolUseId: 'toolu_crash',
      type: 'REIMBURSEMENT_APPROVED',
      payload: {},
    });

    await h.worker.processNextRun();

    expect(await prisma.action.count({ where: { runId: run.id } })).toBe(1);
    expect(
      JSON.parse(
        lastToolResult(h.llm.requests[0]).content as string,
      ) as unknown,
    ).toMatchObject({ ok: true, alreadyRecorded: true });
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
  });

  it('fails when the model ends without a decision', async () => {
    const h = buildHarness(prisma, { script: [endTurn('Não sei.')] });
    const run = await h.runs.create(validInput());
    await h.worker.processNextRun();
    expect((await h.runs.findById(run.id))?.status).toBe('FAILED');
  });

  it('fails after MAX_TURNS assistant messages', async () => {
    const h = buildHarness(prisma, {
      cfg: { MAX_TURNS: '2' },
      script: [toolUse('nope', {}), toolUse('nope', {}), toolUse('nope', {})],
    });
    const run = await h.runs.create(validInput());
    await h.worker.processNextRun();
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: 'FAILED', lastError: 'max turns (2) exceeded' });
  });

  it('fails on refusal and retries on rate limit', async () => {
    const refused = buildHarness(prisma, { script: [stopWith('refusal')] });
    const r1 = await refused.runs.create(validInput());
    await refused.worker.processNextRun();
    expect((await refused.runs.findById(r1.id))?.status).toBe('FAILED');

    await truncateAll(prisma);
    const limited = buildHarness(prisma, {
      script: [
        Anthropic.APIError.generate(
          429,
          undefined,
          'rate limited',
          new Headers(),
        ),
      ],
    });
    const r2 = await limited.runs.create(validInput());
    await limited.worker.processNextRun();
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: r2.id } }),
    ).toMatchObject({ status: 'PENDING' });
  });
});
