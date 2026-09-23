import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { ExpiryService } from '../expiry/expiry.service';
import { InboundProcessor } from '../inbound/inbound.processor';
import { OutboxService } from '../mail/outbox.service';
import { WorkerService } from './worker.service';

const RUNS_PER_TICK = 10;

/**
 * Two independent loops on WORKER_POLL_MS: one drains runs, the other the outbox,
 * inbound replies and expiry. A run inside a long LLM call must not hold up e-mail.
 */
@Injectable()
export class WorkerLoop
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerLoop.name);
  private runsTimer?: NodeJS.Timeout;
  private sideTimer?: NodeJS.Timeout;
  private runsBusy = false;
  private sideBusy = false;
  private lastExpiryAt = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly worker: WorkerService,
    private readonly outbox: OutboxService,
    private readonly inbound: InboundProcessor,
    private readonly expiry: ExpiryService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.WORKER_ENABLED) return;
    const ms = this.cfg.WORKER_POLL_MS;
    this.runsTimer = setInterval(() => void this.tickRuns(), ms);
    this.sideTimer = setInterval(() => void this.tickSide(), ms);
  }

  onApplicationShutdown(): void {
    if (this.runsTimer) clearInterval(this.runsTimer);
    if (this.sideTimer) clearInterval(this.sideTimer);
  }

  async tickRuns(): Promise<void> {
    if (this.runsBusy) return;
    this.runsBusy = true;
    try {
      for (
        let i = 0;
        i < RUNS_PER_TICK && (await this.worker.processNextRun());
        i++
      ) {
        /* keep draining */
      }
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : String(e));
    } finally {
      this.runsBusy = false;
    }
  }

  async tickSide(): Promise<void> {
    if (this.sideBusy) return;
    this.sideBusy = true;
    try {
      await this.outbox.dispatch();
      for (let i = 0; i < 20 && (await this.inbound.processNext()); i++) {
        /* keep draining */
      }
      if (Date.now() - this.lastExpiryAt >= this.cfg.EXPIRY_INTERVAL_MS) {
        this.lastExpiryAt = Date.now(); // scheduling only; expiry itself compares with DB now() (convention 0003)
        await this.expiry.expireDue();
      }
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : String(e));
    } finally {
      this.sideBusy = false;
    }
  }
}
