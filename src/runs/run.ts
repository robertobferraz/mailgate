import type Anthropic from '@anthropic-ai/sdk';
import { Run as RunModel } from '../generated/prisma/client';
import { ReimbursementInput } from './reimbursement-input';

export type RunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export interface Run {
  id: string;
  status: RunStatus;
  input: ReimbursementInput;
  messages: Anthropic.MessageParam[];
  attempts: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Lease {
  runId: string;
  token: string;
}

export class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`lease lost for run ${runId}`);
    this.name = 'LeaseLostError';
  }
}

/** Row shape returned by $queryRaw (snake_case, jsonb already parsed). */
export interface RunRow {
  id: string;
  status: string;
  input: unknown;
  messages: unknown;
  attempts: number;
  lease_token: string | null;
  lease_until: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function rowToRun(r: RunRow): Run {
  return {
    id: r.id,
    status: r.status as RunStatus,
    input: r.input as ReimbursementInput,
    messages: r.messages as Anthropic.MessageParam[],
    attempts: r.attempts,
    leaseToken: r.lease_token,
    leaseUntil: r.lease_until,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function modelToRun(m: RunModel): Run {
  return {
    ...m,
    status: m.status as RunStatus,
    input: m.input as unknown as ReimbursementInput,
    messages: m.messages as unknown as Anthropic.MessageParam[],
  };
}
