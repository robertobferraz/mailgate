import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { LeaseLostError } from '../runs/run';
import { RunRepository } from '../runs/run.repository';
import { AGENT_STEP } from './agent-step';
import type { AgentStep } from './agent-step';
import { backoffSeconds, classifyError } from './errors';

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);
  private inFlight?: AbortController;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly runs: RunRepository,
    @Inject(AGENT_STEP) private readonly agent: AgentStep,
  ) {}

  /** Claims and processes one run. Returns false when nothing was claimable. */
  async processNextRun(): Promise<boolean> {
    const claimed = await this.runs.claim(this.cfg.LEASE_SECONDS);
    if (!claimed) return false;
    const { run, lease } = claimed;

    if (run.attempts > this.cfg.MAX_ATTEMPTS) {
      await this.ignoreLeaseLost(() =>
        this.runs.fail(
          lease,
          `max attempts exceeded: ${run.lastError ?? 'unknown'}`,
        ),
      );
      return true;
    }

    const controller = new AbortController();
    this.inFlight = controller;
    try {
      await this.agent.run(run, lease, controller.signal);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const kind = classifyError(e);
      if (kind === 'aborted') {
        await this.ignoreLeaseLost(() => this.runs.releaseForShutdown(lease));
      } else if (kind === 'lease_lost') {
        this.logger.warn(message);
      } else if (kind === 'permanent') {
        await this.ignoreLeaseLost(() => this.runs.fail(lease, message));
      } else {
        await this.ignoreLeaseLost(() =>
          this.runs.scheduleRetry(lease, message, backoffSeconds(run.attempts)),
        );
      }
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
    return true;
  }

  /** Signals the in-flight run's AbortSignal so the LLM call rejects and the run is released. */
  abortInFlight(): void {
    this.inFlight?.abort();
  }

  private async ignoreLeaseLost(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof LeaseLostError)) throw e;
      this.logger.warn(e.message);
    }
  }
}
