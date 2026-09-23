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

/** Polls on WORKER_POLL_MS. Each tick drains runs, then side tasks (added in F3–F5). */
@Injectable()
export class WorkerLoop
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerLoop.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
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
    this.timer = setInterval(() => void this.tick(), this.cfg.WORKER_POLL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (
        let i = 0;
        i < RUNS_PER_TICK && (await this.worker.processNextRun());
        i++
      ) {
        /* keep draining */
      }
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
      this.busy = false;
    }
  }
}
