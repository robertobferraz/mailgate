import { loadConfig } from './config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://u:p@h:5432/d' });
    expect(c).toMatchObject({
      PORT: 3000,
      DB_POOL_MAX: 10,
      WORKER_ENABLED: true,
      WORKER_POLL_MS: 1000,
      LEASE_SECONDS: 120,
      MAX_ATTEMPTS: 5,
      MAX_TURNS: 10,
      AUTO_APPROVE_LIMIT_CENTS: 50000,
      APPROVAL_TTL_HOURS: 48,
      EXPIRY_INTERVAL_MS: 60000,
      OUTBOX_BATCH: 10,
      LLM_PROVIDER: 'anthropic',
      LLM_MODEL: 'claude-opus-5',
      ANTHROPIC_FALLBACK: 'default',
      LLM_TIMEOUT_MS: 90000,
    });
  });
  it('refuses LLM_TIMEOUT_MS that does not fit inside the lease', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://x',
        LEASE_SECONDS: '60',
        LLM_TIMEOUT_MS: '60000',
      }),
    ).toThrow(/LLM_TIMEOUT_MS/);
  });
  it('parses WORKER_ENABLED=false', () => {
    expect(
      loadConfig({ DATABASE_URL: 'postgresql://x', WORKER_ENABLED: 'false' })
        .WORKER_ENABLED,
    ).toBe(false);
  });
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow();
  });
  it('refuses LLM_PROVIDER=anthropic-compatible without LLM_BASE_URL', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://x',
        LLM_PROVIDER: 'anthropic-compatible',
      }),
    ).toThrow();
  });
  it('accepts LLM_PROVIDER=anthropic-compatible with LLM_BASE_URL', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://x',
        LLM_PROVIDER: 'anthropic-compatible',
        LLM_BASE_URL: 'http://localhost:11434',
      }),
    ).not.toThrow();
  });
});
