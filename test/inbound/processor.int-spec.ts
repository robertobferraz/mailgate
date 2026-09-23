import { PrismaClient } from '../../src/generated/prisma/client';
import { replyPayload } from '../fakes/fake-mail';
import { endTurn, toolUse } from '../fakes/scripted-llm';
import { newPrisma, truncateAll } from '../helpers/db';
import { buildHarness, sentApproval } from '../helpers/harness';

describe('InboundProcessor', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = newPrisma();
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('decides APPROVED from the approver (display name, uppercase) and resumes the run', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await h.deliver(
      'evt_1',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'Gestor <GESTOR@ACME.TEST>',
        text: 'pode aprovar',
      }),
    );

    expect(await h.inbound.processNext()).toBe(true);

    expect(
      await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: approval.id },
      }),
    ).toMatchObject({
      status: 'DECIDED',
      decision: 'APPROVED',
      decisionRawText: 'pode aprovar',
    });
    expect(
      await prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({
        where: { providerEventId: 'evt_1' },
      }),
    ).toMatchObject({
      outcome: 'PROCESSED',
      approvalRequestId: approval.id,
      classification: 'APPROVED',
    });
    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'DECISION_RECEIVED' },
      }),
    ).toBe(1);
    expect(await h.inbound.processNext()).toBe(false);
  });

  it('I6 — a reply from another sender does not decide', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver(
      'evt_2',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'intruso@evil.test',
        text: 'aprovo',
      }),
    );
    await h.inbound.processNext();
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status,
    ).toBe('SENT');
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'evt_2' },
        })
      ).outcome,
    ).toBe('IGNORED_SENDER');
    expect(h.classifier.calls).toBe(0);
  });

  it('ignores an unknown thread without a subject token', async () => {
    const h = buildHarness(prisma);
    await sentApproval(h, prisma);
    await h.deliver(
      'evt_3',
      replyPayload({
        threadId: 'thr_unknown',
        from: 'gestor@acme.test',
        text: 'aprovo',
      }),
    );
    await h.inbound.processNext();
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'evt_3' },
        })
      ).outcome,
    ).toBe('IGNORED_UNKNOWN_THREAD');
  });

  it('correlates by subject token when the thread id is missing', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver(
      'evt_4',
      replyPayload({
        threadId: null,
        from: 'gestor@acme.test',
        text: 'recuso, falta nota fiscal',
        subject: `RES: [MAILGATE #${approval.subjectToken.toUpperCase()}] Reembolso`,
      }),
    );
    await h.inbound.processNext();
    expect(
      await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: approval.id },
      }),
    ).toMatchObject({ status: 'DECIDED', decision: 'REJECTED' });
  });

  it('ignores replies to an already decided request without calling the classifier again', async () => {
    const h = buildHarness(prisma);
    const { approval } = await sentApproval(h, prisma);
    await h.deliver(
      'evt_5',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'aprovo',
      }),
    );
    await h.deliver(
      'evt_6',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'recuso',
      }),
    );
    await h.inbound.processNext();
    await h.inbound.processNext();
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { providerEventId: 'evt_6' },
        })
      ).outcome,
    ).toBe('IGNORED_ALREADY_DECIDED');
    expect(h.classifier.calls).toBe(1);
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).decision,
    ).toBe('APPROVED');
  });

  it('I3 — the same event delivered twice produces one decision', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    const payload = replyPayload({
      threadId: approval.providerThreadId,
      from: 'gestor@acme.test',
      text: 'aprovo',
    });
    expect(await h.deliver('evt_same', payload)).toBe(true);
    expect(await h.deliver('evt_same', payload)).toBe(false);
    while (await h.inbound.processNext()) {
      /* drain */
    }
    expect(await prisma.inboundEvent.count()).toBe(1);
    expect(
      await prisma.runEvent.count({
        where: { runId: run.id, type: 'DECISION_RECEIVED' },
      }),
    ).toBe(1);
  });

  it('F4 acceptance (in-process) — run > R$ 500 → e-mail → "pode aprovar" → COMPLETED with one action', async () => {
    const h = buildHarness(prisma);
    const { run, approval } = await sentApproval(h, prisma);
    await h.deliver(
      'evt_e2e',
      replyPayload({
        threadId: approval.providerThreadId,
        from: 'gestor@acme.test',
        text: 'pode aprovar',
      }),
    );
    await h.inbound.processNext();
    h.llm.push(
      toolUse('record_decision', {
        decision: 'APPROVED',
        reason: 'aprovado pelo gestor',
      }),
      endTurn(),
    );
    await h.worker.processNextRun();
    expect((await h.runs.findById(run.id))?.status).toBe('COMPLETED');
    expect(await prisma.action.count({ where: { runId: run.id } })).toBe(1);
  });
});
