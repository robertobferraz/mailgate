import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { ANTHROPIC_SDK } from '../agent/llm-client';
import { createLlmSdk, isNativeAnthropic } from '../agent/llm-sdk';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import type { Classification, ReplyClassifier } from './reply-classifier';

const schema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'UNCLEAR']),
  note: z.string(),
});

const SYSTEM = [
  'Você classifica a resposta de um gestor a um pedido de aprovação de reembolso.',
  'APPROVED: o gestor aprova claramente (ex.: "aprovo", "pode aprovar", "ok, pode pagar").',
  'REJECTED: o gestor recusa claramente (ex.: "recuso", "não aprovo", "recusa, falta nota fiscal").',
  'UNCLEAR: qualquer dúvida, pergunta, condição ou ambiguidade. Na dúvida, responda UNCLEAR.',
  'Ignore texto citado de e-mails anteriores. Em note, resuma o comentário do gestor em uma frase.',
].join('\n');

const JSON_ONLY_INSTRUCTION =
  'Responda apenas com um objeto JSON no formato {"decision": "APPROVED"|"REJECTED"|"UNCLEAR", "note": string}, sem nenhum outro texto.';

const UNCLEAR: Classification = {
  decision: 'UNCLEAR',
  note: 'classificação indisponível',
};

/**
 * Lenient extraction for local models (e.g. qwen3) that wrap JSON in ```json fences or add
 * surrounding prose: take the substring from the first '{' to the last '}'. Falls back to the
 * raw text (letting JSON.parse throw) when no braces are present.
 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end !== -1 && end > start
    ? text.slice(start, end + 1)
    : text;
}

@Injectable()
export class ClaudeReplyClassifier implements ReplyClassifier {
  private readonly client: Anthropic;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Optional() @Inject(ANTHROPIC_SDK) client?: Anthropic,
  ) {
    this.client = client ?? createLlmSdk(this.cfg);
  }

  async classify(text: string): Promise<Classification> {
    if (isNativeAnthropic(this.cfg)) {
      return this.classifyNative(text);
    }
    return this.classifyCompatible(text);
  }

  private async classifyNative(text: string): Promise<Classification> {
    const res = await this.client.messages.parse({
      model: this.cfg.LLM_MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { effort: 'low', format: zodOutputFormat(schema) },
      messages: [
        { role: 'user', content: `Resposta do gestor:\n"""\n${text}\n"""` },
      ],
    });
    return res.parsed_output ?? UNCLEAR;
  }

  private async classifyCompatible(text: string): Promise<Classification> {
    // Network/SDK errors must propagate (same as the native branch) so the caller can
    // retry after the lease instead of silently turning a transient outage into UNCLEAR,
    // which would send the one-and-only clarification e-mail and close the inbound event.
    const res = await this.client.messages.create({
      model: this.cfg.LLM_MODEL,
      max_tokens: 2000,
      system: `${SYSTEM}\n${JSON_ONLY_INSTRUCTION}`,
      messages: [
        { role: 'user', content: `Resposta do gestor:\n"""\n${text}\n"""` },
      ],
    });
    try {
      const block = res.content.find((b) => b.type === 'text');
      if (!block || block.type !== 'text') return UNCLEAR;
      const parsed: unknown = JSON.parse(extractJsonObject(block.text));
      const result = schema.safeParse(parsed);
      return result.success ? result.data : UNCLEAR;
    } catch {
      return UNCLEAR;
    }
  }
}
