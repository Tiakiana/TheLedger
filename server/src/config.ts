import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  publicDir: string;
  /** Public URL of the app (e.g. https://ledger.example.com). Used for origin checks. */
  publicUrl: string | null;
  /** Extra allowed origins for browser requests, besides the request's own host. */
  allowedOrigins: string[];
  gmUsername: string;
  gmPassword: string | null;
  sessionTtlHours: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  /** Durations, configurable mainly for tests. The specification fixes them at 5 s and 5 min. */
  cancelWindowMs: number;
  approvalWindowMs: number;
  maxImageBytes: number;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Loads configuration from environment variables (and a .env file in the working directory, if present). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): Config {
  const envFile = path.join(root, '.env');
  if (env === process.env && fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch (err) {
      console.warn(`Could not read ${envFile}:`, err);
    }
  }
  const publicUrl = env.PUBLIC_URL?.trim() || null;
  const tlsCertFile = env.TLS_CERT_FILE?.trim() || null;
  const tlsKeyFile = env.TLS_KEY_FILE?.trim() || null;
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: Number(env.PORT) || 8080,
    databasePath: path.resolve(root, env.DATABASE_PATH?.trim() || 'data/ledger.db'),
    publicDir: path.resolve(root, env.PUBLIC_DIR?.trim() || 'dist/public'),
    publicUrl,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    gmUsername: env.GM_USERNAME?.trim() || 'gm',
    gmPassword: env.GM_PASSWORD || null,
    sessionTtlHours: Number(env.SESSION_TTL_HOURS) || 24 * 14,
    cookieSecure: bool(env.COOKIE_SECURE, Boolean(tlsCertFile) || Boolean(publicUrl?.startsWith('https://'))),
    trustProxy: bool(env.TRUST_PROXY, false),
    tlsCertFile,
    tlsKeyFile,
    cancelWindowMs: 5_000,
    approvalWindowMs: 5 * 60_000,
    maxImageBytes: (Number(env.MAX_IMAGE_KB) || 2048) * 1024,
  };
}
