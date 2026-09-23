import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config/config';

export function isNativeAnthropic(cfg: AppConfig): boolean {
  return cfg.LLM_PROVIDER === 'anthropic';
}

export function createLlmSdk(cfg: AppConfig): Anthropic {
  const apiKey =
    cfg.LLM_API_KEY ??
    (cfg.LLM_PROVIDER === 'anthropic-compatible' ? 'not-needed' : undefined);
  return new Anthropic({
    apiKey,
    baseURL: cfg.LLM_BASE_URL,
    timeout: cfg.LLM_TIMEOUT_MS,
    maxRetries: 0,
  });
}
