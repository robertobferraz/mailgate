import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config';
import type { LlmClient, LlmRequest } from '../agent/llm-client';
import { RECORD_DECISION, REQUEST_APPROVAL } from '../agent/tools';

const msg = (
  content: unknown[],
  stop_reason: Anthropic.Message['stop_reason'],
): Anthropic.Message =>
  ({
    id: `msg_demo_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: 'demo',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }) as unknown as Anthropic.Message;
const call = (name: string, input: Record<string, unknown>) =>
  msg(
    [{ type: 'tool_use', id: `toolu_demo_${randomUUID()}`, name, input }],
    'tool_use',
  );

/** Deterministic agent for DEMO=true (adr 0012): same decisions a well-behaved model makes. */
export class DemoLlmClient implements LlmClient {
  constructor(private readonly cfg: AppConfig) {}

  createMessage(req: LlmRequest): Promise<Anthropic.Message> {
    const first = req.messages[0];
    const initial = typeof first.content === 'string' ? first.content : '';
    const amount = Number(/"amountCents":\s*(\d+)/.exec(initial)?.[1] ?? 0);
    const lastAssistant = [...req.messages]
      .reverse()
      .find((m) => m.role === 'assistant');
    const lastTool =
      lastAssistant && typeof lastAssistant.content !== 'string'
        ? lastAssistant.content.find(
            (b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use',
          )
        : undefined;
    const last = req.messages[req.messages.length - 1];
    const resultText =
      typeof last.content !== 'string'
        ? last.content
            .map((b) =>
              b.type === 'tool_result' && typeof b.content === 'string'
                ? b.content
                : '',
            )
            .join('')
        : '';

    if (!lastTool) {
      return Promise.resolve(
        amount > this.cfg.AUTO_APPROVE_LIMIT_CENTS
          ? call(REQUEST_APPROVAL, {
              summary: 'Pedido acima do limite de aprovação automática.',
              recommendation: 'APPROVE',
              rationale: 'Despesa compatível com a categoria e com a política.',
            })
          : call(RECORD_DECISION, {
              decision: 'APPROVED',
              reason: 'Dentro do limite e da política.',
            }),
      );
    }
    if (lastTool.name === REQUEST_APPROVAL) {
      const decision = /"decision":"REJECTED"/.test(resultText)
        ? 'REJECTED'
        : 'APPROVED';
      return Promise.resolve(
        call(RECORD_DECISION, { decision, reason: 'Decisão do gestor.' }),
      );
    }
    return Promise.resolve(
      msg([{ type: 'text', text: 'Pronto.', citations: null }], 'end_turn'),
    );
  }
}
