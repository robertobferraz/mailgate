import type Anthropic from '@anthropic-ai/sdk';
import { ActionRepository } from '../../src/actions/action.repository';
import { AgentRunner } from '../../src/agent/agent-runner';
import { ApprovalRepository } from '../../src/approvals/approval.repository';
import { ExpiryService } from '../../src/expiry/expiry.service';
import { PrismaClient } from '../../src/generated/prisma/client';
import { InboundEventRepository } from '../../src/inbound/inbound-event.repository';
import { InboundProcessor } from '../../src/inbound/inbound.processor';
import { OutboxService } from '../../src/mail/outbox.service';
import { toInboundEvent } from '../../src/mail/mail-provider';
import { RunRepository } from '../../src/runs/run.repository';
import { WorkerService } from '../../src/worker/worker.service';
import { FakeClassifier } from '../fakes/fake-classifier';
import { FakeMailProvider } from '../fakes/fake-mail';
import { toolUse, ScriptedLlmClient } from '../fakes/scripted-llm';
import { testConfig } from './config';
import { validInput } from './fixtures';

export function buildHarness(
  prisma: PrismaClient,
  opts: {
    script?: Array<Anthropic.Message | Error>;
    cfg?: Record<string, string>;
    classifierDelayMs?: number;
  } = {},
) {
  const cfg = testConfig(opts.cfg);
  const runs = new RunRepository(prisma);
  const approvals = new ApprovalRepository(prisma);
  const actions = new ActionRepository(prisma);
  const llm = new ScriptedLlmClient(opts.script ?? []);
  const agent = new AgentRunner(cfg, prisma, runs, approvals, actions, llm);
  const worker = new WorkerService(cfg, runs, agent);
  const mail = new FakeMailProvider();
  const outbox = new OutboxService(cfg, prisma, mail);
  const classifier = new FakeClassifier(opts.classifierDelayMs ?? 0);
  const events = new InboundEventRepository(prisma);
  const inbound = new InboundProcessor(
    cfg,
    prisma,
    events,
    approvals,
    runs,
    classifier,
    mail,
  );
  /** Simulates the webhook: normalize + insertIfAbsent. */
  const deliver = (eventId: string, payload: unknown) =>
    events.insertIfAbsent(toInboundEvent(eventId, payload));
  const expiry = new ExpiryService(prisma, runs);
  return {
    cfg,
    runs,
    approvals,
    actions,
    llm,
    agent,
    worker,
    mail,
    outbox,
    classifier,
    events,
    inbound,
    deliver,
    expiry,
  };
}

/** A R$ 840,00 run paused on request_approval with its approval already SENT (used by F4/F5 tests). */
export async function sentApproval(
  h: ReturnType<typeof buildHarness>,
  prisma: PrismaClient,
) {
  h.llm.push(
    toolUse(
      'request_approval',
      {
        summary: 'Hotel 2 diárias',
        recommendation: 'APPROVE',
        rationale: 'dentro da média',
      },
      'toolu_ask',
    ),
  );
  const run = await h.runs.create(validInput({ amountCents: 84000 }));
  await h.worker.processNextRun();
  await h.outbox.dispatch();
  const approval = await prisma.approvalRequest.findFirstOrThrow({
    where: { runId: run.id },
  });
  return { run, approval };
}
