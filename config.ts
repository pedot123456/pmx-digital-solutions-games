import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pinPolicyError } from '@shared/admin'

// Load .env if present (Node 20.12+). Real environment variables win.
try {
  process.loadEnvFile?.('.env')
} catch {
  /* no .env file – defaults apply */
}

function defaultDataDir(): string {
  // Keep the live database out of OneDrive/synced folders: syncing open database files corrupts them.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Nerv Centre Word Rush', 'data')
  }
  return path.resolve('data')
}

export interface ServerConfig {
  port: number
  host: string
  /** Empty = embedded PostgreSQL (PGlite) in `dataDir`; set to use a PostgreSQL server. */
  databaseUrl: string
  dataDir: string
  adminDefaultPin: string
  backupDir: string
  clientDist: string
  https: { key: Buffer; cert: Buffer } | null
  appVersion: string
  logLevel: string
  /** When set, saved to the `public_base_url` setting at start-up (address in the join QR code). */
  publicBaseUrl: string | null
}

function readTls(): ServerConfig['https'] {
  const keyFile = process.env.TLS_KEY_FILE
  const certFile = process.env.TLS_CERT_FILE
  if (!keyFile || !certFile) return null
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    throw new Error(`TLS_KEY_FILE / TLS_CERT_FILE not found: ${keyFile}, ${certFile}`)
  }
  return { key: readFileSync(keyFile), cert: readFileSync(certFile) }
}

function readVersion(): string {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function loadConfig(): ServerConfig {
  const dataDir = process.env.DATA_DIR || defaultDataDir()
  return {
    port: Number(process.env.PORT ?? 8090),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL ?? '',
    dataDir,
    adminDefaultPin: process.env.ADMIN_DEFAULT_PIN || '1234',
    backupDir: process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(dataDir)), 'backups'),
    clientDist: path.resolve(process.env.CLIENT_DIST || 'dist/client'),
    https: readTls(),
    appVersion: readVersion(),
    logLevel: process.env.LOG_LEVEL ?? 'warn',
    // On Render the service's public address is known (RENDER_EXTERNAL_URL) – phones join through it.
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || null,
  }
}

/**
 * Settings that would lose data or leave Admin open on a public cloud host. On Render (RENDER is set):
 * the disk is wiped on every deploy / restart, so a PostgreSQL DATABASE_URL is required; and the
 * first-login PIN must not be the well-known default, or anyone could claim Admin first.
 */
export function cloudProblems(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.RENDER) return []
  const problems: string[] = []
  if (!config.databaseUrl && env.ALLOW_EPHEMERAL_DB !== '1') {
    problems.push('DATABASE_URL is not set. Render wipes the disk on every deploy and restart, so every game and answer would be lost. Set DATABASE_URL to a PostgreSQL database (for example Neon) – see README → "Deploy on Render".')
  }
  const pinProblem = pinPolicyError(env.ADMIN_DEFAULT_PIN ?? '')
  if (pinProblem) {
    problems.push(`ADMIN_DEFAULT_PIN must be your own first-login PIN, not 1234 (${pinProblem}): on a public address the first person to sign in with it would take over Admin.`)
  }
  return problems
}
