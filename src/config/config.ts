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
    LLM_PROVIDER: z
      .enum(['anthropic', 'anthropic-compatible'])
      .default('anthropic'),
    LLM_BASE_URL: z.string().url().optional(),
    LLM_MODEL: z.string().default('claude-opus-5'),
    LLM_API_KEY: z.string().optional(),
    // per-call bound; the SDK does not retry, the worker's backoff does
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90000),
    ANTHROPIC_FALLBACK: z.enum(['default', 'off']).default('default'),
    AGENTMAIL_API_KEY: z.string().optional(),
    AGENTMAIL_INBOX_ID: z.string().optional(),
    AGENTMAIL_WEBHOOK_SECRET: z.string().optional(),
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
    // a call that outlives the lease lets another worker reclaim the run mid-call (I4)
    if (cfg.LLM_TIMEOUT_MS >= cfg.LEASE_SECONDS * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LLM_TIMEOUT_MS must be shorter than LEASE_SECONDS',
        path: ['LLM_TIMEOUT_MS'],
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
