import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { LeaseLostError } from '../runs/run';
import { backoffSeconds, classifyError, PermanentError } from './errors';

const apiError = (status: number) =>
  Anthropic.APIError.generate(
    status,
    undefined,
    `status ${status}`,
    new Headers(),
  );

describe('classifyError', () => {
  it.each([
    [new LeaseLostError('r'), 'lease_lost'],
    [new PermanentError('x'), 'permanent'],
    [apiError(429), 'transient'],
    [apiError(529), 'transient'],
    [apiError(500), 'transient'],
    [apiError(400), 'permanent'],
    [apiError(401), 'permanent'],
    [apiError(404), 'permanent'],
    [apiError(302), 'transient'],
    [new Error('socket hang up'), 'transient'],
  ])('%p -> %s', (e, kind) => {
    expect(classifyError(e)).toBe(kind);
  });

  it('classifies OpenAI.APIError by status the same way as Anthropic.APIError', () => {
    expect(
      classifyError(new OpenAI.APIError(429, {}, 'rate', new Headers())),
    ).toBe('transient');
    expect(
      classifyError(new OpenAI.APIError(400, {}, 'bad', new Headers())),
    ).toBe('permanent');
    // sub-400 status: not in the transient set by name, but must not be
    // treated as a client error either (matches classifyError's pre-refactor
    // fallthrough of unmatched statuses to 'transient')
    expect(
      classifyError(new OpenAI.APIError(302, {}, 'redirect', new Headers())),
    ).toBe('transient');
  });
});

describe('backoffSeconds', () => {
  it('grows exponentially from 5s and caps at 300s', () => {
    expect([1, 2, 3, 4, 7, 20].map(backoffSeconds)).toEqual([
      5, 10, 20, 40, 300, 300,
    ]);
  });
});
