import { buildInitialMessage } from '../agent/prompts';
import { loadConfig } from '../config/config';
import { DemoLlmClient } from './demo-llm';

const cfg = loadConfig({ DATABASE_URL: 'postgresql://x' });
const input = (amountCents: number) => ({
  description: 'd',
  amountCents,
  category: 'TRAVEL' as const,
  requesterEmail: 'a@x.test',
  approverEmail: 'g@x.test',
});

it('asks for approval above the limit', async () => {
  const m = await new DemoLlmClient(cfg).createMessage({
    system: '',
    tools: [],
    messages: [{ role: 'user', content: buildInitialMessage(input(84000)) }],
  });
  expect(m.content[0]).toMatchObject({
    type: 'tool_use',
    name: 'request_approval',
  });
});
it('approves alone at or below the limit', async () => {
  const m = await new DemoLlmClient(cfg).createMessage({
    system: '',
    tools: [],
    messages: [{ role: 'user', content: buildInitialMessage(input(50000)) }],
  });
  expect(m.content[0]).toMatchObject({
    type: 'tool_use',
    name: 'record_decision',
    input: { decision: 'APPROVED' },
  });
});
it('records the human decision after the approval result', async () => {
  const m = await new DemoLlmClient(cfg).createMessage({
    system: '',
    tools: [],
    messages: [
      { role: 'user', content: buildInitialMessage(input(84000)) },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'request_approval', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: '{"decision":"REJECTED","note":"sem nota"}',
          },
        ],
      },
    ],
  });
  expect(m.content[0]).toMatchObject({
    type: 'tool_use',
    name: 'record_decision',
    input: { decision: 'REJECTED' },
  });
});
it('ends the turn after record_decision', async () => {
  const m = await new DemoLlmClient(cfg).createMessage({
    system: '',
    tools: [],
    messages: [
      { role: 'user', content: buildInitialMessage(input(100)) },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'record_decision', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' },
        ],
      },
    ],
  });
  expect(m.stop_reason).toBe('end_turn');
});
