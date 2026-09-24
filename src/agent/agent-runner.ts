import type Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable } from '@nestjs/common';
import { ActionRepository } from '../actions/action.repository';
import { ApprovalRepository } from '../approvals/approval.repository';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Lease, Run } from '../runs/run';
import { appendRunEvent, RunEventType } from '../runs/run-events';
import { RunRepository } from '../runs/run.repository';
import { AgentStep } from '../worker/agent-step';
import { PermanentError, ShutdownAbortError } from '../worker/errors';
import { LLM_CLIENT } from './llm-client';
import type { LlmClient } from './llm-client';
import { buildInitialMessage, buildSystemPrompt } from './prompts';
import {
  RECORD_DECISION,
  recordDecisionInput,
  REQUEST_APPROVAL,
  requestApprovalInput,
  TOOLS,
} from './tools';

type ToolOutcome =
  | {
      kind: 'result';
      result: Anthropic.ToolResultBlockParam;
      event?: { type: RunEventType; data: Record<string, unknown> };
    }
  | { kind: 'paused' };

const errorResult = (
  id: string,
  message: string,
): Anthropic.ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: id,
  content: message,
  is_error: true,
});
const okResult = (
  id: string,
  body: Record<string, unknown>,
): Anthropic.ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: id,
  content: JSON.stringify(body),
});

function toolUseOf(
  message: Anthropic.MessageParam,
): Anthropic.ToolUseBlockParam | undefined {
  if (message.role !== 'assistant' || typeof message.content === 'string')
    return undefined;
  return message.content.find(
    (b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use',
  );
}

@Injectable()
export class AgentRunner implements AgentStep {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    private readonly runs: RunRepository,
    private readonly approvals: ApprovalRepository,
    private readonly actions: ActionRepository,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  async run(run: Run, lease: Lease, signal?: AbortSignal): Promise<void> {
    let messages: Anthropic.MessageParam[] = [...run.messages];
    if (messages.length === 0) {
      messages = [{ role: 'user', content: buildInitialMessage(run.input) }];
      await this.save(lease, messages);
    }

    for (;;) {
      const last = messages[messages.length - 1];
      if (last.role === 'assistant') {
        const toolUse = toolUseOf(last);
        if (!toolUse) return this.finish(run, lease);
        const outcome = await this.executeTool(run, lease, toolUse);
        if (outcome.kind === 'paused') return;
        messages = [...messages, { role: 'user', content: [outcome.result] }];
        await this.runs.saveMessages(
          lease,
          messages,
          this.cfg.LEASE_SECONDS,
          outcome.event,
        );
        continue;
      }

      const turns = messages.filter((m) => m.role === 'assistant').length;
      if (turns >= this.cfg.MAX_TURNS)
        throw new PermanentError(`max turns (${this.cfg.MAX_TURNS}) exceeded`);

      let response: Anthropic.Message;
      try {
        response = await this.llm.createMessage({
          system: buildSystemPrompt(this.cfg.AUTO_APPROVE_LIMIT_CENTS),
          tools: TOOLS,
          messages,
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw new ShutdownAbortError();
        throw e;
      }
      if (response.stop_reason === 'refusal')
        throw new PermanentError('model refused the request');
      if (response.stop_reason === 'max_tokens')
        throw new Error('model hit max_tokens');

      // append-only, verbatim (convention 0005); persisted BEFORE any tool runs (D010)
      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
      ];
      await this.save(lease, messages);
    }
  }

  private save(
    lease: Lease,
    messages: Anthropic.MessageParam[],
  ): Promise<void> {
    return this.runs.saveMessages(lease, messages, this.cfg.LEASE_SECONDS);
  }

  private async finish(run: Run, lease: Lease): Promise<void> {
    const action = await this.actions.findForRun(this.prisma, run.id);
    if (!action) throw new PermanentError('agent ended without a decision');
    await this.runs.complete(lease);
  }

  private async executeTool(
    run: Run,
    lease: Lease,
    block: Anthropic.ToolUseBlockParam,
  ): Promise<ToolOutcome> {
    switch (block.name) {
      case RECORD_DECISION:
        return {
          kind: 'result',
          result: await this.recordDecision(run, block),
        };
      case REQUEST_APPROVAL:
        return this.requestApproval(run, lease, block);
      default:
        return {
          kind: 'result',
          result: errorResult(
            block.id,
            `ferramenta desconhecida: ${block.name}`,
          ),
        };
    }
  }

  private async recordDecision(
    run: Run,
    block: Anthropic.ToolUseBlockParam,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const parsed = recordDecisionInput.safeParse(block.input);
    if (!parsed.success)
      return errorResult(block.id, `entrada inválida: ${parsed.error.message}`);
    const { decision, reason } = parsed.data;

    const existing = await this.actions.findForRun(this.prisma, run.id);
    if (existing && existing.toolUseId !== block.id) {
      return errorResult(
        block.id,
        'decisão já registrada para este pedido; encerre sem chamar ferramentas',
      );
    }

    const human = await this.approvals.findDecidedForRun(this.prisma, run.id);
    if (human && human.decision !== decision) {
      return errorResult(
        block.id,
        `a decisão do gestor foi ${human.decision}; registre exatamente essa decisão`,
      );
    }
    if (
      !human &&
      decision === 'APPROVED' &&
      run.input.amountCents > this.cfg.AUTO_APPROVE_LIMIT_CENTS
    ) {
      return errorResult(
        block.id,
        'valor acima do limite de aprovação automática: chame request_approval antes de aprovar',
      );
    }

    const inserted = await this.prisma.$transaction(async (tx) => {
      const ok = await this.actions.recordIfAbsent(tx, {
        runId: run.id,
        toolUseId: block.id,
        type:
          decision === 'APPROVED'
            ? 'REIMBURSEMENT_APPROVED'
            : 'REIMBURSEMENT_REJECTED',
        payload: {
          reason,
          amountCents: run.input.amountCents,
          decidedBy: human ? 'HUMAN' : 'AGENT',
        },
      });
      if (ok)
        await appendRunEvent(tx, run.id, 'ACTION_RECORDED', {
          decision,
          toolUseId: block.id,
        });
      return ok;
    });
    return okResult(block.id, { ok: true, alreadyRecorded: !inserted });
  }

  private async requestApproval(
    run: Run,
    lease: Lease,
    block: Anthropic.ToolUseBlockParam,
  ): Promise<ToolOutcome> {
    const existing = await this.approvals.findByToolUse(
      this.prisma,
      run.id,
      block.id,
    );

    if (existing?.status === 'DECIDED') {
      return {
        kind: 'result',
        result: okResult(block.id, {
          decision: existing.decision,
          note: existing.decisionNote,
          decidedBy: existing.approverEmail,
        }),
        event: {
          type: 'RESUMED',
          data: { approvalId: existing.id, decision: existing.decision },
        },
      };
    }
    if (existing?.status === 'EXPIRED')
      throw new PermanentError('approval request expired');

    const parsed = requestApprovalInput.safeParse(block.input);
    if (!parsed.success)
      return {
        kind: 'result',
        result: errorResult(
          block.id,
          `entrada inválida: ${parsed.error.message}`,
        ),
      };

    await this.prisma.$transaction(async (tx) => {
      await this.approvals.createIfAbsent(tx, {
        runId: run.id,
        toolUseId: block.id,
        approverEmail: run.input.approverEmail,
        ...parsed.data,
        ttlHours: this.cfg.APPROVAL_TTL_HOURS,
      });
      await this.runs.toWaitingApproval(tx, lease); // I5: lease released, attempts reset
      await appendRunEvent(tx, run.id, 'APPROVAL_REQUESTED', {
        toolUseId: block.id,
      });
    });
    return { kind: 'paused' };
  }
}
