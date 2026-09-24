import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { endTurn, toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';
import { buildHarness, sentApproval } from '../helpers/harness';

const ASK = {
  summary: 'Hotel 2 diárias',
  recommendation: 'APPROVE',
  rationale: 'dentro da média',
};

async function decide(
  prisma: PrismaClient,
  runId: string,
  decision: 'APPROVED' | 'REJECTED',
  note = 'ok',
) {
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.updateMany({
      where: { runId },
      data: { status: 'DECIDED', decision, decisionNote: note },
    });
    await tx.run.updateMany({
      where: { id: runId, status: 'WAITING_APPROVAL' },
      data: { status: 'PENDING', attempts: 0 },
    });
  });
}

describe('AgentRunner — pause and resume', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('I5 — request_approval parks the run without a lease and creates the approval', async () => {
    const h = buildHarness(prisma, {
      script: [toolUse('request_approval', ASK, 'toolu_ask')],
    });
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({
      status: 'WAITING_APPROVAL',
      leaseToken: null,
      leaseUntil: null,
      attempts: 0,
    });
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id },
    });
    expect(approval).toMatchObject({
      status: 'CREATED',
      toolUseId: 'toolu_ask',
      approverEmail: 'gestor@acme.test',
      summary: ASK.summary,
    });
    expect(await h.runs.claim(60)).toBeNull();
    expect(h.llm.requests).toHaveLength(1);
    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'APPROVAL_REQUESTED' },
      }),
    ).toBe(1);
  });

  it('resumes after APPROVED: tool_result carries the decision, action by HUMAN, run COMPLETED', async () => {
    const h = buildHarness(prisma, {
      script: [toolUse('request_approval', ASK, 'toolu_ask')],
    });
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    await decide(prisma, run.id, 'APPROVED', 'pode aprovar');

    h.llm.push(
      toolUse('record_decision', {
        decision: 'APPROVED',
        reason: 'aprovado pelo gestor',
      }),
      endTurn(),
    );
    await h.worker.processNextRun();

    const resumedReq = h.llm.requests[1];
    const last = resumedReq.messages[resumedReq.messages.length - 1];
    const result = (last.content as Anthropic.ToolResultBlockParam[])[0];
    expect(result.tool_use_id).toBe('toolu_ask');
    expect(JSON.parse(result.content as string)).toEqual({
      decision: 'APPROVED',
      note: 'pode aprovar',
      decidedBy: 'gestor@acme.test',
    });
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
    expect(
      (await prisma.action.findFirstOrThrow({ where: { runId: run.id } }))
        .payload,
    ).toMatchObject({ decidedBy: 'HUMAN' });
    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'RESUMED' },
      }),
    ).toBe(1);
  });

  it('refuses a record_decision that contradicts the human decision', async () => {
    const h = buildHarness(prisma, {
      script: [toolUse('request_approval', ASK)],
    });
    const run = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    await decide(prisma, run.id, 'REJECTED', 'falta nota fiscal');

    h.llm.push(
      toolUse('record_decision', { decision: 'APPROVED', reason: 'x' }),
      toolUse('record_decision', {
        decision: 'REJECTED',
        reason: 'falta nota fiscal',
      }),
      endTurn(),
    );
    await h.worker.processNextRun();

    const afterWrong = h.llm.requests[2].messages.at(-1)!;
    expect(
      (afterWrong.content as Anthropic.ToolResultBlockParam[])[0].is_error,
    ).toBe(true);
    expect(
      (await prisma.action.findFirstOrThrow({ where: { runId: run.id } })).type,
    ).toBe('REIMBURSEMENT_REJECTED');
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
  });

  it('F2 acceptance — below the limit completes alone; above stops in WAITING_APPROVAL', async () => {
    const h = buildHarness(prisma, {
      script: [
        toolUse('record_decision', { decision: 'APPROVED', reason: 'ok' }),
        endTurn(),
        toolUse('request_approval', ASK),
      ],
    });
    const small = await h.runs.create(validInput({ amountCents: 30000 }));
    const big = await h.runs.create(validInput({ amountCents: 84000 }));
    await h.worker.processNextRun();
    await h.worker.processNextRun();
    expect((await h.runs.findById(small.id))?.status).toBe('COMPLETED');
    expect((await h.runs.findById(big.id))?.status).toBe('WAITING_APPROVAL');
  });

  it('writes RESUMED once even if the process dies before the resume is saved', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await h.deliver(
      'evt_r',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'aprovo',
      }),
    );
    await h.inbound.processNext();

    // first resume: crash on the save that carries the tool_result
    const spy = jest
      .spyOn(h.runs, 'saveMessages')
      .mockRejectedValueOnce(new Error('simulated crash'));
    await h.worker.processNextRun();
    spy.mockRestore();
    await prisma.run.update({
      where: { id: run.id },
      data: { leaseUntil: new Date(0) },
    });

    h.llm.push(
      toolUse('record_decision', {
        decision: 'APPROVED',
        reason: 'gestor aprovou',
      }),
      endTurn(),
    );
    await h.worker.processNextRun();

    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'RESUMED' },
      }),
    ).toBe(1);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status,
    ).toBe('COMPLETED');
  });
});
