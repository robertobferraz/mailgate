import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
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
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WorkerLoop.name);
  private runsTimer?: NodeJS.Timeout;
  private sideTimer?: NodeJS.Timeout;
  private stopping = false;
  private runsInFlight: Promise<void> | null = null;
  private sideInFlight: Promise<void> | null = null;
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

  /**
   * Drains in-flight work before Prisma disconnects in onApplicationShutdown (adr 0008).
   * Stops claiming new runs immediately, waits up to SHUTDOWN_GRACE_MS for whatever is
   * already running, and aborts it if the grace period runs out.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.runsTimer) clearInterval(this.runsTimer);
    if (this.sideTimer) clearInterval(this.sideTimer);
    const drained = Promise.allSettled(
      [this.runsInFlight, this.sideInFlight].filter(
        (p): p is Promise<void> => p !== null,
      ),
    ).then(() => true);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), this.cfg.SHUTDOWN_GRACE_MS);
    });
    const ok = await Promise.race([drained, timeout]);
    clearTimeout(timer);
    if (!ok) {
      this.logger.warn('shutdown grace exceeded; aborting in-flight run');
      this.worker.abortInFlight();
      await Promise.race([drained, new Promise((r) => setTimeout(r, 1000))]);
    }
  }

  tickRuns(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.runsInFlight) return this.runsInFlight;
    this.runsInFlight = this.drainRuns().finally(() => {
      this.runsInFlight = null;
    });
    return this.runsInFlight;
  }

  private async drainRuns(): Promise<void> {
    try {
      for (
        let i = 0;
        i < RUNS_PER_TICK &&
        !this.stopping &&
        (await this.worker.processNextRun());
        i++
      ) {
        /* keep draining */
      }
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : String(e));
    }
  }

  tickSide(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.sideInFlight) return this.sideInFlight;
    this.sideInFlight = this.drainSide().finally(() => {
      this.sideInFlight = null;
    });
    return this.sideInFlight;
  }

  private async drainSide(): Promise<void> {
    try {
      await this.outbox.dispatch(() => this.stopping);
      if (this.stopping) return;
      for (
        let i = 0;
        i < 20 && !this.stopping && (await this.inbound.processNext());
        i++
      ) {
        /* keep draining */
      }
      if (this.stopping) return;
      if (Date.now() - this.lastExpiryAt >= this.cfg.EXPIRY_INTERVAL_MS) {
        this.lastExpiryAt = Date.now(); // scheduling only; expiry itself compares with DB now() (convention 0003)
        await this.expiry.expireDue();
      }
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : String(e));
    }
  }
}
