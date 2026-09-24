import OpenAI from 'openai';
import { z } from 'zod';
import { createOpenAiSdk } from '../agent/openai-llm-client';
import type { AppConfig } from '../config/config';
import {
  SYSTEM,
  UNCLEAR,
  extractJsonObject,
  schema,
} from './claude-reply-classifier';
import type { Classification, ReplyClassifier } from './reply-classifier';

export class OpenAiReplyClassifier implements ReplyClassifier {
  private readonly client: OpenAI;

  constructor(
    private readonly cfg: AppConfig,
    client?: OpenAI,
  ) {
    this.client = client ?? createOpenAiSdk(cfg);
  }

  async classify(text: string): Promise<Classification> {
    const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema);
    delete jsonSchema.$schema;
    const c = await this.client.chat.completions.create({
      model: this.cfg.LLM_MODEL,
      max_completion_tokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Resposta do gestor:\n"""\n${text}\n"""` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'reply_classification',
          strict: this.cfg.LLM_STRICT_OUTPUT,
          schema: jsonSchema,
        },
      },
    });
    if (c.choices[0]?.finish_reason === 'length') {
      throw new Error('classifier output truncated (finish_reason=length)');
    }
    const raw = c.choices[0]?.message?.content ?? '';
    try {
      const parsed = schema.safeParse(JSON.parse(extractJsonObject(raw)));
      return parsed.success ? parsed.data : UNCLEAR;
    } catch {
      return UNCLEAR; // network errors propagate (retried by the inbound loop); bad output does not
    }
  }
}
