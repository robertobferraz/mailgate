import { z } from 'zod';

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().default(3000),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    WORKER_ENABLED: z
      .string()
      .optional()
      .transform((v) => v !== 'false'),
    WORKER_POLL_MS: z.coerce.number().int().min(10).default(1000),
    LEASE_SECONDS: z.coerce.number().int().min(1).default(120),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    MAX_TURNS: z.coerce.number().int().min(1).default(10),
    AUTO_APPROVE_LIMIT_CENTS: z.coerce.number().int().min(0).default(50000),
    APPROVAL_TTL_HOURS: z.coerce.number().int().min(1).default(48),
    EXPIRY_INTERVAL_MS: z.coerce.number().int().min(10).default(60000),
    OUTBOX_BATCH: z.coerce.number().int().min(1).default(10),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(10).default(8000),
    LLM_PROVIDER: z
      .enum(['anthropic', 'anthropic-compatible', 'openai-compatible'])
      .default('anthropic'),
    LLM_BASE_URL: z.string().url().optional(),
    LLM_MODEL: z.string().default('claude-opus-5'),
    LLM_API_KEY: z.string().optional(),
    LLM_STRICT_OUTPUT: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    // per-call bound; the SDK does not retry, the worker's backoff does
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90000),
    ANTHROPIC_FALLBACK: z.enum(['default', 'off']).default('default'),
    AGENTMAIL_API_KEY: z.string().optional(),
    AGENTMAIL_INBOX_ID: z.string().optional(),
    AGENTMAIL_WEBHOOK_SECRET: z.string().optional(),
    DEMO: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    NODE_ENV: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.LLM_PROVIDER === 'anthropic-compatible' && !cfg.LLM_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'LLM_BASE_URL is required when LLM_PROVIDER=anthropic-compatible',
        path: ['LLM_BASE_URL'],
      });
    }
    if (cfg.LLM_PROVIDER === 'openai-compatible' && !cfg.LLM_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LLM_API_KEY is required when LLM_PROVIDER=openai-compatible',
        path: ['LLM_API_KEY'],
      });
    }
    // a call that outlives the lease lets another worker reclaim the run mid-call (I4)
    if (cfg.LLM_TIMEOUT_MS >= cfg.LEASE_SECONDS * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LLM_TIMEOUT_MS must be shorter than LEASE_SECONDS',
        path: ['LLM_TIMEOUT_MS'],
      });
    }
    if (cfg.DEMO && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DEMO must not be enabled in production',
        path: ['DEMO'],
      });
    }
    if (cfg.DEMO && !cfg.AGENTMAIL_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'AGENTMAIL_WEBHOOK_SECRET is required in DEMO (replies are really signed)',
        path: ['AGENTMAIL_WEBHOOK_SECRET'],
      });
    }
    // docker-compose stop_grace_period is 15s; drain must finish before SIGKILL (adr 0008)
    if (cfg.SHUTDOWN_GRACE_MS >= 15000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'SHUTDOWN_GRACE_MS must be shorter than 15000 (stop_grace_period)',
        path: ['SHUTDOWN_GRACE_MS'],
      });
    }
  });

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return schema.parse(env);
}
