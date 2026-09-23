import { Injectable } from '@nestjs/common';
import { Lease, Run } from '../runs/run';
import { RunRepository } from '../runs/run.repository';

/**
 * One processing pass over a claimed run. It must leave the run COMPLETED, FAILED or
 * WAITING_APPROVAL, or throw (the worker applies the retry policy).
 */
export interface AgentStep {
  run(run: Run, lease: Lease): Promise<void>;
}
export const AGENT_STEP = Symbol('AGENT_STEP');

/** F1 stub: completes every run. Replaced by AgentRunner in F2. */
@Injectable()
export class StubAgentStep implements AgentStep {
  constructor(private readonly runs: RunRepository) {}
  async run(_run: Run, lease: Lease): Promise<void> {
    await this.runs.complete(lease);
  }
}
