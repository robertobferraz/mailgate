import Anthropic from '@anthropic-ai/sdk';
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
    [new Error('socket hang up'), 'transient'],
  ])('%p -> %s', (e, kind) => {
    expect(classifyError(e)).toBe(kind);
  });
});

describe('backoffSeconds', () => {
  it('grows exponentially from 5s and caps at 300s', () => {
    expect([1, 2, 3, 4, 7, 20].map(backoffSeconds)).toEqual([
      5, 10, 20, 40, 300, 300,
    ]);
  });
});
