import Anthropic from '@anthropic-ai/sdk';
import { LeaseLostError } from '../runs/run';

/** Errors that must not be retried: the run goes to FAILED. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export type ErrorKind = 'lease_lost' | 'permanent' | 'transient';

export function classifyError(e: unknown): ErrorKind {
  if (e instanceof LeaseLostError) return 'lease_lost';
  if (e instanceof PermanentError) return 'permanent';
  if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
    const s = e.status;
    if (s === 408 || s === 409 || s === 429 || s >= 500) return 'transient';
    if (s >= 400) return 'permanent';
  }
  // connection errors and unknown failures: retry; MAX_ATTEMPTS bounds it
  return 'transient';
}

export function backoffSeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}
