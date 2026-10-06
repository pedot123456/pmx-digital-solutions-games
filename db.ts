import { mkdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'

export type Row = Record<string, unknown>

/**
 * Minimal SQL interface used by the repositories. Two implementations:
 * - PGlite: real PostgreSQL compiled to WASM, embedded in the Node process (booth / offline / tests)
 * - pg: a regular PostgreSQL server via DATABASE_URL (e.g. Azure Database for PostgreSQL)
 */
export interface Db {
  readonly kind: 'pglite' | 'postgres'
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>
  /** Runs `fn` in a transaction; nested calls reuse the outer transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

interface PgliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  exec(sql: string): Promise<unknown>
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const
  constructor(
    private readonly conn: PgliteLike,
    private readonly root: PGlite | null,
  ) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.conn.query<T>(sql, params)).rows
  }

  async exec(sql: string): Promise<void> {
    await this.conn.exec(sql)
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.root) return fn(this)
    return this.root.transaction((tx) => fn(new PgliteDb(tx as unknown as PgliteLike, null)))
  }

  async close(): Promise<void> {
    await this.root?.close()
  }
}

// pg returns int8/numeric as strings; everything we count or average fits in a JS number.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10))
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v))

class PostgresDb implements Db {
  readonly kind = 'postgres' as const
  constructor(
    private readonly pool: pg.Pool,
    private readonly client: pg.PoolClient | null = null,
  ) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await (this.client ?? this.pool).query(sql, params as unknown[])
    return res.rows as T[]
  }

  async exec(sql: string): Promise<void> {
    await (this.client ?? this.pool).query(sql)
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(new PostgresDb(this.pool, client))
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    if (!this.client) await this.pool.end()
  }
}

/**
 * `databaseUrl` set → PostgreSQL server. Otherwise PGlite stored in `dataDir`
 * ("memory://" gives a throw-away in-memory database for tests).
 */
export async function openDb(opts: { databaseUrl?: string; dataDir: string }): Promise<Db> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: Number(process.env.PG_POOL_MAX) || 10, keepAlive: true, idleTimeoutMillis: 30_000 })
    // Hosted databases (Neon, Supabase…) close idle connections now and then. Without a listener that
    // error would stop the whole server; the pool simply opens a new connection on the next query.
    pool.on('error', (err) => console.warn(`PostgreSQL: idle connection closed (${err.message}) – reconnecting on the next query.`))
    await pool.query('SELECT 1')
    return new PostgresDb(pool)
  }
  if (opts.dataDir !== 'memory://') mkdirSync(opts.dataDir, { recursive: true })
  const db = await PGlite.create(opts.dataDir === 'memory://' ? undefined : opts.dataDir)
  return new PgliteDb(db as unknown as PgliteLike, db)
}
