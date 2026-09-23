import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config/config';
import { ClaudeReplyClassifier } from './claude-reply-classifier';

const cfg = (extra: Record<string, string> = {}) =>
  loadConfig({ DATABASE_URL: 'postgresql://x', ...extra });

describe('ClaudeReplyClassifier', () => {
  describe('native Anthropic (LLM_PROVIDER=anthropic)', () => {
    it('returns the parsed output', async () => {
      const parse = jest.fn().mockResolvedValue({
        parsed_output: { decision: 'APPROVED', note: 'pode aprovar' },
      });
      const c = new ClaudeReplyClassifier(cfg(), {
        messages: { parse },
      } as unknown as Anthropic);
      expect(await c.classify('pode aprovar')).toEqual({
        decision: 'APPROVED',
        note: 'pode aprovar',
      });
      const [params] = parse.mock.calls[0] as [Record<string, unknown>];
      expect(params).toMatchObject({
        model: 'claude-opus-5',
        output_config: { effort: 'low' },
      });
      expect(JSON.stringify(params.messages)).toContain('pode aprovar');
    });

    it('falls back to UNCLEAR when parsing fails (null parsed_output)', async () => {
      const parse = jest.fn().mockResolvedValue({ parsed_output: null });
      const c = new ClaudeReplyClassifier(cfg(), {
        messages: { parse },
      } as unknown as Anthropic);
      expect((await c.classify('???')).decision).toBe('UNCLEAR');
    });
  });

  describe('anthropic-compatible (LLM_PROVIDER=anthropic-compatible)', () => {
    const compatCfg = () =>
      cfg({
        LLM_PROVIDER: 'anthropic-compatible',
        LLM_BASE_URL: 'http://localhost:11434',
        LLM_MODEL: 'qwen3:8b',
      });

    it('parses a valid JSON text block and sends no output_config', async () => {
      const create = jest.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ decision: 'REJECTED', note: 'falta nota' }),
          },
        ],
      });
      const c = new ClaudeReplyClassifier(compatCfg(), {
        messages: { create },
      } as unknown as Anthropic);
      expect(await c.classify('recuso, falta nota')).toEqual({
        decision: 'REJECTED',
        note: 'falta nota',
      });
      const [params] = create.mock.calls[0] as [Record<string, unknown>];
      expect(params).toMatchObject({ model: 'qwen3:8b' });
      expect(params).not.toHaveProperty('output_config');
    });

    it('returns UNCLEAR when the response is not valid JSON', async () => {
      const create = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'not json at all' }],
      });
      const c = new ClaudeReplyClassifier(compatCfg(), {
        messages: { create },
      } as unknown as Anthropic);
      expect(await c.classify('???')).toEqual({
        decision: 'UNCLEAR',
        note: 'classificação indisponível',
      });
    });

    it('returns UNCLEAR when the parsed JSON fails schema validation', async () => {
      const create = jest.fn().mockResolvedValue({
        content: [
          { type: 'text', text: JSON.stringify({ decision: 'MAYBE' }) },
        ],
      });
      const c = new ClaudeReplyClassifier(compatCfg(), {
        messages: { create },
      } as unknown as Anthropic);
      expect(await c.classify('hmm')).toEqual({
        decision: 'UNCLEAR',
        note: 'classificação indisponível',
      });
    });

    it('propagates errors from messages.create instead of swallowing them as UNCLEAR', async () => {
      const create = jest.fn().mockRejectedValue(new Error('network down'));
      const c = new ClaudeReplyClassifier(compatCfg(), {
        messages: { create },
      } as unknown as Anthropic);
      await expect(c.classify('pode aprovar')).rejects.toThrow('network down');
    });

    it('extracts JSON from a ```json fenced response with surrounding prose', async () => {
      const create = jest.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: 'Claro, aqui está:\n```json\n{"decision": "APPROVED", "note": "pode aprovar"}\n```\nEspero ter ajudado.',
          },
        ],
      });
      const c = new ClaudeReplyClassifier(compatCfg(), {
        messages: { create },
      } as unknown as Anthropic);
      expect(await c.classify('pode aprovar')).toEqual({
        decision: 'APPROVED',
        note: 'pode aprovar',
      });
    });
  });
});
