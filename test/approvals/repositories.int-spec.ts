import { PrismaClient } from '../../src/generated/prisma/client';
import { ActionRepository } from '../../src/actions/action.repository';
import { ApprovalRepository } from '../../src/approvals/approval.repository';
import { RunRepository } from '../../src/runs/run.repository';
import { newPrisma, truncateAll } from '../helpers/db';
import { validInput } from '../helpers/fixtures';

describe('approval and action repositories', () => {
  let prisma: PrismaClient;
  let runs: RunRepository;
  let approvals: ApprovalRepository;
  let actions: ActionRepository;
  beforeAll(() => {
    prisma = newPrisma();
    runs = new RunRepository(prisma);
    approvals = new ApprovalRepository(prisma);
    actions = new ActionRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  const approvalParams = (runId: string) => ({
    runId,
    toolUseId: 'toolu_1',
    approverEmail: 'gestor@acme.test',
    summary: 's',
    recommendation: 'APPROVE' as const,
    rationale: 'r',
    ttlHours: 48,
  });

  it('createIfAbsent is idempotent per (run_id, tool_use_id) and sets token and expiry', async () => {
    const run = await runs.create(validInput());
    await approvals.createIfAbsent(prisma, approvalParams(run.id));
    await approvals.createIfAbsent(prisma, approvalParams(run.id));
    expect(await prisma.approvalRequest.count()).toBe(1);
    const a = (await approvals.findByToolUse(prisma, run.id, 'toolu_1'))!;
    expect(a).toMatchObject({
      status: 'CREATED',
      decision: null,
      clarificationSent: false,
    });
    expect(a.subjectToken).toMatch(/^[a-z2-7]{8}$/);
    const hours = (a.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
  });

  it('recordIfAbsent returns true then false and does not abort the surrounding transaction', async () => {
    const run = await runs.create(validInput());
    const p = {
      runId: run.id,
      toolUseId: 'toolu_x',
      type: 'REIMBURSEMENT_APPROVED' as const,
      payload: { reason: 'ok' },
    };
    const results = await prisma.$transaction(async (tx) => {
      const first = await actions.recordIfAbsent(tx, p);
      const second = await actions.recordIfAbsent(tx, p);
      const count = await tx.action.count(); // would throw "transaction is aborted" after a P2002
      return { first, second, count };
    });
    expect(results).toEqual({ first: true, second: false, count: 1 });
    expect((await actions.findForRun(prisma, run.id))?.toolUseId).toBe(
      'toolu_x',
    );
  });

  it('resumeFromDecision only moves WAITING_APPROVAL runs to PENDING and resets attempts', async () => {
    const run = await runs.create(validInput());
    expect(await runs.resumeFromDecision(prisma, run.id)).toBe(false);
    await prisma.run.update({
      where: { id: run.id },
      data: { status: 'WAITING_APPROVAL', attempts: 3 },
    });
    expect(await runs.resumeFromDecision(prisma, run.id)).toBe(true);
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: 'PENDING', attempts: 0 });
  });
});
