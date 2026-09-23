import { loadConfig } from '../config/config';
import type { ExpiryService } from '../expiry/expiry.service';
import type { InboundProcessor } from '../inbound/inbound.processor';
import type { OutboxService } from '../mail/outbox.service';
import { WorkerLoop } from './worker.loop';
import type { WorkerService } from './worker.service';

describe('WorkerLoop', () => {
  it('keeps e-mail and expiry work moving while a run is stuck in a slow LLM call', async () => {
    const worker = {
      processNextRun: jest.fn(() => new Promise<boolean>(() => {})),
    };
    const outbox = { dispatch: jest.fn().mockResolvedValue(undefined) };
    const inbound = { processNext: jest.fn().mockResolvedValue(false) };
    const expiry = { expireDue: jest.fn().mockResolvedValue(0) };
    const loop = new WorkerLoop(
      loadConfig({ DATABASE_URL: 'postgresql://x', WORKER_ENABLED: 'false' }),
      worker as unknown as WorkerService,
      outbox as unknown as OutboxService,
      inbound as unknown as InboundProcessor,
      expiry as unknown as ExpiryService,
    );

    void loop.tickRuns();
    await loop.tickSide();

    expect(worker.processNextRun).toHaveBeenCalledTimes(1);
    expect(outbox.dispatch).toHaveBeenCalledTimes(1);
    expect(inbound.processNext).toHaveBeenCalledTimes(1);
    expect(expiry.expireDue).toHaveBeenCalledTimes(1);
  });
});
