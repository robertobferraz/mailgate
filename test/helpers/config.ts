import { AppConfig, loadConfig } from '../../src/config/config';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...process.env, WORKER_ENABLED: 'false', ...overrides });
}
