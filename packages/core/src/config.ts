import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  AUTH_MODE: z.enum(['dev', 'cognito']).default('dev'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
  AUTH_ISSUER_URL: z.string().url().default('http://localhost:8788'),
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),
  DDB_ENDPOINT: z.string().optional(),
  TABLE_NAME: z.string().default('CareCircle'),
  QUEUE_MODE: z.enum(['memory', 'sqs']).default('memory'),
  QUEUE_URL: z.string().optional(),
  MAIL_MODE: z.enum(['smtp', 'ses', 'memory']).default('smtp'),
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('care-circle@example.com'),
  CRYPTO_MODE: z.enum(['local', 'kms']).default('local'),
  KMS_KEY_ID: z.string().optional(),
  LOCAL_DATA_KEY: z.string().optional(),
  DEV_ENDPOINTS: bool,
  DEV_KEY: z.string().optional(),
  RUN_WORKERS: bool,
  WORKER_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  AWS_REGION: z.string().default('us-east-1'),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_IDS: z.string().optional(),
  /** Cognito mode: where our RFC 8414 facade points (option a: straight at Cognito; b: our /oauth proxy). */
  COGNITO_DOMAIN: z.string().optional(),
  OAUTH_PROXY: bool,
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  PORT: z.coerce.number().int().positive().default(8787),
});

export type Config = z.infer<typeof envSchema> & {
  mcpResource: string;
  apiResource: string;
  corsOrigins: string[];
  cognitoClientIds: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const base = parsed.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (parsed.CRYPTO_MODE === 'local' && !parsed.LOCAL_DATA_KEY) {
    throw new Error('LOCAL_DATA_KEY is required in local crypto mode. Run `npm run gen:key` and put it in .env.');
  }
  if (parsed.DEV_ENDPOINTS && (!parsed.DEV_KEY || parsed.DEV_KEY.length < 16)) {
    throw new Error('DEV_ENDPOINTS=true needs a DEV_KEY of at least 16 characters.');
  }
  return {
    ...parsed,
    mcpResource: `${base}/mcp`,
    apiResource: `${base}/api`,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    cognitoClientIds: (parsed.COGNITO_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
