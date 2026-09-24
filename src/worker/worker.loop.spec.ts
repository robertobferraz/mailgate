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

describe('WorkerLoop shutdown', () => {
  const cfg = (grace = '50') =>
    loadConfig({
      DATABASE_URL: 'postgresql://x',
      WORKER_ENABLED: 'false',
      SHUTDOWN_GRACE_MS: grace,
    });
  const side = () => ({
    outbox: { dispatch: jest.fn().mockResolvedValue(0) },
    inbound: { processNext: jest.fn().mockResolvedValue(false) },
    expiry: { expireDue: jest.fn().mockResolvedValue(0) },
  });

  it('waits for the in-flight run before resolving', async () => {
    let finish!: () => void;
    const worker = {
      processNextRun: jest.fn(
        () => new Promise<boolean>((r) => (finish = () => r(false))),
      ),
      abortInFlight: jest.fn(),
    };
    const s = side();
    const loop = new WorkerLoop(
      cfg('5000'),
      worker as unknown as WorkerService,
      s.outbox as unknown as OutboxService,
      s.inbound as unknown as InboundProcessor,
      s.expiry as unknown as ExpiryService,
    );
    void loop.tickRuns();
    let done = false;
    const p = loop.beforeApplicationShutdown().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    finish();
    await p;
    expect(done).toBe(true);
    expect(worker.abortInFlight).not.toHaveBeenCalled();
  });

  it('aborts the in-flight run when the grace period runs out', async () => {
    let finish!: () => void;
    const worker = {
      processNextRun: jest.fn(
        () => new Promise<boolean>((r) => (finish = () => r(false))),
      ),
      abortInFlight: jest.fn(() => finish()),
    };
    const s = side();
    const loop = new WorkerLoop(
      cfg('50'),
      worker as unknown as WorkerService,
      s.outbox as unknown as OutboxService,
      s.inbound as unknown as InboundProcessor,
      s.expiry as unknown as ExpiryService,
    );
    void loop.tickRuns();
    await loop.beforeApplicationShutdown();
    expect(worker.abortInFlight).toHaveBeenCalledTimes(1);
  });

  it('claims no new run once stopping', async () => {
    const worker = {
      processNextRun: jest.fn().mockResolvedValue(true),
      abortInFlight: jest.fn(),
    };
    const s = side();
    const loop = new WorkerLoop(
      cfg(),
      worker as unknown as WorkerService,
      s.outbox as unknown as OutboxService,
      s.inbound as unknown as InboundProcessor,
      s.expiry as unknown as ExpiryService,
    );
    await loop.beforeApplicationShutdown();
    await loop.tickRuns();
    await loop.tickSide();
    expect(worker.processNextRun).not.toHaveBeenCalled();
    expect(s.outbox.dispatch).not.toHaveBeenCalled();
  });

  it('passes a stopping check to outbox.dispatch and skips inbound/expiry once it flips mid-dispatch', async () => {
    const worker = {
      processNextRun: jest.fn(() => new Promise<boolean>(() => {})),
      abortInFlight: jest.fn(),
    };
    let resolveDispatch!: (n: number) => void;
    const outbox = {
      dispatch: jest.fn(
        () => new Promise<number>((r) => (resolveDispatch = r)),
      ),
    };
    const inbound = { processNext: jest.fn().mockResolvedValue(false) };
    const expiry = { expireDue: jest.fn().mockResolvedValue(0) };
    const loop = new WorkerLoop(
      cfg('5000'),
      worker as unknown as WorkerService,
      outbox as unknown as OutboxService,
      inbound as unknown as InboundProcessor,
      expiry as unknown as ExpiryService,
    );

    const sidePromise = loop.tickSide();
    const shutdownPromise = loop.beforeApplicationShutdown();
    expect(outbox.dispatch).toHaveBeenCalledWith(expect.any(Function));
    resolveDispatch(0);
    await sidePromise;
    await shutdownPromise;

    expect(inbound.processNext).not.toHaveBeenCalled();
    expect(expiry.expireDue).not.toHaveBeenCalled();
  });

  it('stops draining inbound events once stopping flips between events', async () => {
    const worker = {
      processNextRun: jest.fn(() => new Promise<boolean>(() => {})),
      abortInFlight: jest.fn(),
    };
    const outbox = { dispatch: jest.fn().mockResolvedValue(0) };
    const inbound = { processNext: jest.fn().mockResolvedValue(true) };
    const expiry = { expireDue: jest.fn().mockResolvedValue(0) };
    const loop = new WorkerLoop(
      cfg('5000'),
      worker as unknown as WorkerService,
      outbox as unknown as OutboxService,
      inbound as unknown as InboundProcessor,
      expiry as unknown as ExpiryService,
    );
    let calls = 0;
    inbound.processNext.mockImplementation(() => {
      calls++;
      if (calls === 1) void loop.beforeApplicationShutdown();
      return Promise.resolve(true);
    });

    await loop.tickSide();

    expect(inbound.processNext).toHaveBeenCalledTimes(1);
    expect(expiry.expireDue).not.toHaveBeenCalled();
  });
});
