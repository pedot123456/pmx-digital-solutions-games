import type { FeedbackMode } from '@shared/feedback'
import { withDefaults } from '@shared/seed'
import type { GameMode, GameRules, Puzzle, RaceStatus, RunProgress, RunStatus, Settings, Solution } from '@shared/types'
import type { AffiliationType } from '@shared/validation'
import type { Db } from './db'
import { runMigrations } from './migrations'
import { openDb } from './db'
import { seedContent } from './seed'

/** Every SQL statement lives here; services and the game engine only call these methods. */

const ms = (v: unknown): number | null => (v === null || v === undefined ? null : new Date(v as string | Date).getTime())
const iso = (v: number | null | undefined) => (v === null || v === undefined ? null : new Date(v).toISOString())

export interface RaceRecord {
  id: string
  mode: GameMode
  status: RaceStatus
  room_code: string | null
  rules: GameRules
  puzzles: Puzzle[]
  host_token_hash: string | null
  kiosk_id: string | null
  is_test: boolean
  created_at: number
  howto_ends_at: number | null
  go_at: number | null
  ended_at: number | null
}

export interface RunRecord {
  id: string
  race_id: string
  player_id: string
  lane: number
  full_name: string
  affiliation_type: AffiliationType
  project_name: string | null
  opu: string | null
  token_hash: string
  device_id: string | null
  status: RunStatus
  progress: RunProgress
  solved: number
  time_ms: number | null
  penalty_ms: number
  wrong: number
  skips: number
  place: number | null
  is_winner: boolean
  is_test: boolean
  removed_at: number | null
  removed_reason: string | null
  created_at: number
  ended_at: number | null
}

/** An ended run with everything boards, results and analytics need. */
export interface EndedRun {
  id: string
  race_id: string
  player_id: string
  mode: GameMode
  full_name: string
  affiliation_type: AffiliationType
  project_name: string | null
  opu: string | null
  name_key: string
  /** "p:<project key>" or "o:<opu key>" (before project merges). */
  affil_key: string
  status: RunStatus
  solved: number
  total: number
  time_ms: number
  penalty_ms: number
  wrong: number
  skips: number
  progress: RunProgress
  puzzle_ids: string[]
  is_winner: boolean
  place: number | null
  is_test: boolean
  removed_at: number | null
  removed_reason: string | null
  created_at: number
  ended_at: number
}

/** One row of the feedback table. */
export interface FeedbackRow {
  feedback_id: string
  /** The game (run) the answer followed. */
  session_id: string
  player_id: string
  /** The Battle / Head-to-Head race; null for Solo. */
  team_id: string | null
  full_name: string
  affiliation_type: AffiliationType
  project_name: string | null
  opu: string | null
  q1_relevant: boolean
  q2_would_explore: boolean
  q2_interested_solutions: string[] | null
  q3_understanding_rating: number
  game_mode: FeedbackMode
  submitted_at: number
  is_test: boolean
}

/** A feedback row with what reporting needs from the game and the player. */
export interface FeedbackRecord extends FeedbackRow {
  /** Solo / Battle / Head-to-Head. */
  race_mode: GameMode
  name_key: string
  affil_key: string
}

/** KL calendar day of a feedback answer (the "once per day" rule). */
const FEEDBACK_DAY = `(f.submitted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date`

export interface AdminUser {
  id: string
  pin_hash: string
  must_change_pin: boolean
  failed_attempts: number
  locked_until: number | null
}

function raceFrom(r: Record<string, unknown>): RaceRecord {
  return {
    id: r.id as string,
    mode: r.mode as GameMode,
    status: r.status as RaceStatus,
    room_code: (r.room_code as string) ?? null,
    rules: r.rules as GameRules,
    puzzles: (r.puzzles as Puzzle[]) ?? [],
    host_token_hash: (r.host_token_hash as string) ?? null,
    kiosk_id: (r.kiosk_id as string) ?? null,
    is_test: !!r.is_test,
    created_at: ms(r.created_at)!,
    howto_ends_at: ms(r.howto_ends_at),
    go_at: ms(r.go_at),
    ended_at: ms(r.ended_at),
  }
}

function runFrom(r: Record<string, unknown>): RunRecord {
  return {
    id: r.id as string,
    race_id: r.race_id as string,
    player_id: r.player_id as string,
    lane: Number(r.lane),
    full_name: r.full_name as string,
    affiliation_type: r.affiliation_type as AffiliationType,
    project_name: (r.project_name as string) ?? null,
    opu: (r.opu as string) ?? null,
    token_hash: r.token_hash as string,
    device_id: (r.device_id as string) ?? null,
    status: r.status as RunStatus,
    progress: r.progress as RunProgress,
    solved: Number(r.solved),
    time_ms: r.time_ms === null ? null : Number(r.time_ms),
    penalty_ms: Number(r.penalty_ms),
    wrong: Number(r.wrong),
    skips: Number(r.skips),
    place: r.place === null ? null : Number(r.place),
    is_winner: !!r.is_winner,
    is_test: !!r.is_test,
    removed_at: ms(r.removed_at),
    removed_reason: (r.removed_reason as string) ?? null,
    created_at: ms(r.created_at)!,
    ended_at: ms(r.ended_at),
  }
}

export class Store {
  constructor(readonly db: Db) {}

  close() {
    return this.db.close()
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async getSettings(): Promise<Settings> {
    const rows = await this.db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings')
    return withDefaults(Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Settings>)
  }

  async setSettings(patch: Partial<Settings>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      await this.db.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      )
    }
  }

  // ── Solutions ─────────────────────────────────────────────────────────────

  async listSolutions(): Promise<Solution[]> {
    const rows = await this.db.query<Solution>('SELECT id, position, name, clue, description, decoys FROM solutions ORDER BY position, id')
    return rows.map((r) => ({ ...r, position: Number(r.position), decoys: Array.isArray(r.decoys) ? r.decoys : [] }))
  }

  async upsertSolution(s: Solution): Promise<void> {
    await this.db.query(
      `INSERT INTO solutions (id, position, name, clue, description, decoys) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, name = EXCLUDED.name, clue = EXCLUDED.clue,
         description = EXCLUDED.description, decoys = EXCLUDED.decoys, updated_at = now()`,
      [s.id, s.position, s.name, s.clue, s.description, JSON.stringify(s.decoys)],
    )
  }

  // ── Players ───────────────────────────────────────────────────────────────

  /** Same normalised full name + project / OPU → same player (latest spelling kept for display). */
  async upsertPlayer(p: {
    id: string
    full_name: string
    affiliation_type: AffiliationType
    project_name: string | null
    opu: string | null
    name_key: string
    affil_key: string
  }): Promise<string> {
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO players (id, full_name, affiliation_type, project_name, opu, name_key, affil_key) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (name_key, affil_key) DO UPDATE SET full_name = EXCLUDED.full_name, project_name = EXCLUDED.project_name,
         opu = EXCLUDED.opu, last_seen_at = now()
       RETURNING id`,
      [p.id, p.full_name, p.affiliation_type, p.project_name, p.opu, p.name_key, p.affil_key],
    )
    return row.id
  }

  async getPlayer(id: string): Promise<{ id: string; name_key: string; affil_key: string } | null> {
    const [row] = await this.db.query<{ id: string; name_key: string; affil_key: string }>('SELECT id, name_key, affil_key FROM players WHERE id = $1', [id])
    return row ?? null
  }

  /** Every (name, project name) spelling players actually typed – the input for project grouping and labels. */
  async projectEntries(includeTest = false): Promise<{ name: string; project: string }[]> {
    return this.db.query(
      `SELECT DISTINCT r.full_name AS name, r.project_name AS project FROM runs r
        WHERE r.affiliation_type = 'project' AND r.project_name IS NOT NULL AND r.status <> 'left'
          AND ($1::boolean OR (r.is_test = false AND r.removed_at IS NULL))`,
      [includeTest],
    )
  }

  // ── Races & runs ──────────────────────────────────────────────────────────

  async insertRace(r: RaceRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO races (id, mode, status, room_code, rules, puzzles, host_token_hash, kiosk_id, is_test, created_at, howto_ends_at, go_at, ended_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
      [
        r.id, r.mode, r.status, r.room_code, JSON.stringify(r.rules), JSON.stringify(r.puzzles), r.host_token_hash, r.kiosk_id,
        r.is_test, iso(r.created_at), iso(r.howto_ends_at), iso(r.go_at), iso(r.ended_at),
      ],
    )
  }

  async updateRace(r: RaceRecord): Promise<void> {
    await this.db.query(
      `UPDATE races SET status = $2, rules = $3::jsonb, puzzles = $4::jsonb, howto_ends_at = $5, go_at = $6, ended_at = $7, updated_at = now()
        WHERE id = $1`,
      [r.id, r.status, JSON.stringify(r.rules), JSON.stringify(r.puzzles), iso(r.howto_ends_at), iso(r.go_at), iso(r.ended_at)],
    )
  }

  async getRace(id: string): Promise<RaceRecord | null> {
    const [row] = await this.db.query('SELECT * FROM races WHERE id = $1', [id])
    return row ? raceFrom(row) : null
  }

  async openRaces(): Promise<RaceRecord[]> {
    return (await this.db.query(`SELECT * FROM races WHERE status IN ('lobby', 'howto', 'running') ORDER BY created_at`)).map(raceFrom)
  }

  async insertRun(r: RunRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO runs (id, race_id, player_id, lane, full_name, affiliation_type, project_name, opu, token_hash, device_id, status, progress,
                         solved, time_ms, penalty_ms, wrong, skips, place, is_winner, is_test, created_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        r.id, r.race_id, r.player_id, r.lane, r.full_name, r.affiliation_type, r.project_name, r.opu, r.token_hash, r.device_id, r.status,
        JSON.stringify(r.progress), r.solved, r.time_ms, r.penalty_ms, r.wrong, r.skips, r.place, r.is_winner, r.is_test, iso(r.created_at), iso(r.ended_at),
      ],
    )
  }

  /** Saves a run's live state (status, progress, result). */
  async saveRun(r: RunRecord): Promise<void> {
    await this.db.query(
      `UPDATE runs SET status = $2, progress = $3::jsonb, solved = $4, time_ms = $5, penalty_ms = $6, wrong = $7, skips = $8,
              place = $9, is_winner = $10, ended_at = $11, token_hash = $12, updated_at = now()
        WHERE id = $1`,
      [r.id, r.status, JSON.stringify(r.progress), r.solved, r.time_ms, r.penalty_ms, r.wrong, r.skips, r.place, r.is_winner, iso(r.ended_at), r.token_hash],
    )
  }

  async runsForRace(raceId: string): Promise<RunRecord[]> {
    return (await this.db.query('SELECT * FROM runs WHERE race_id = $1 ORDER BY lane', [raceId])).map(runFrom)
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const [row] = await this.db.query('SELECT * FROM runs WHERE id = $1', [id])
    return row ? runFrom(row) : null
  }

  /**
   * Ended runs (finished or out of time) with player keys.
   * Boards/stats use `includeTest = false`; Admin can ask for everything.
   */
  async endedRuns(opts: { from?: number; to?: number; includeTest?: boolean; includeRemoved?: boolean } = {}): Promise<EndedRun[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT r.id, r.race_id, r.player_id, ra.mode, r.full_name, r.affiliation_type, r.project_name, r.opu,
              p.name_key, p.affil_key, r.status, r.solved, r.time_ms, r.penalty_ms, r.wrong, r.skips, r.progress,
              jsonb_path_query_array(ra.puzzles, '$[*].solution_id') AS puzzle_ids, jsonb_array_length(ra.puzzles) AS total,
              r.is_winner, r.place, r.is_test, r.removed_at, r.removed_reason, r.created_at, r.ended_at
         FROM runs r JOIN races ra ON ra.id = r.race_id JOIN players p ON p.id = r.player_id
        WHERE r.status IN ('finished', 'timeout') AND r.ended_at IS NOT NULL
          AND ($1::timestamptz IS NULL OR r.ended_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR r.ended_at < $2::timestamptz)
          AND ($3::boolean OR r.is_test = false)
          AND ($4::boolean OR r.removed_at IS NULL)
        ORDER BY r.ended_at`,
      [iso(opts.from), iso(opts.to), !!opts.includeTest, !!opts.includeRemoved],
    )
    return rows.map((r) => ({
      id: r.id as string,
      race_id: r.race_id as string,
      player_id: r.player_id as string,
      mode: r.mode as GameMode,
      full_name: r.full_name as string,
      affiliation_type: r.affiliation_type as AffiliationType,
      project_name: (r.project_name as string) ?? null,
      opu: (r.opu as string) ?? null,
      name_key: r.name_key as string,
      affil_key: r.affil_key as string,
      status: r.status as RunStatus,
      solved: Number(r.solved),
      total: Number(r.total),
      time_ms: Number(r.time_ms),
      penalty_ms: Number(r.penalty_ms),
      wrong: Number(r.wrong),
      skips: Number(r.skips),
      progress: r.progress as RunProgress,
      puzzle_ids: (r.puzzle_ids as string[]) ?? [],
      is_winner: !!r.is_winner,
      place: r.place === null ? null : Number(r.place),
      is_test: !!r.is_test,
      removed_at: ms(r.removed_at),
      removed_reason: (r.removed_reason as string) ?? null,
      created_at: ms(r.created_at)!,
      ended_at: ms(r.ended_at)!,
    }))
  }

  /** Runs started today that never ended properly (left a lobby, still playing) – for Admin counts. */
  async countRunsByStatus(from: number, to: number): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM runs WHERE created_at >= $1 AND created_at < $2 AND is_test = false GROUP BY status`,
      [iso(from), iso(to)],
    )
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]))
  }

  async setRunRemoved(id: string, reason: string | null): Promise<boolean> {
    const rows = await this.db.query(
      reason === null
        ? `UPDATE runs SET removed_at = NULL, removed_reason = NULL, updated_at = now() WHERE id = $1 RETURNING id`
        : `UPDATE runs SET removed_at = now(), removed_reason = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      reason === null ? [id] : [id, reason],
    )
    return rows.length > 0
  }

  async setRunTest(id: string, isTest: boolean): Promise<boolean> {
    const rows = await this.db.query(`UPDATE runs SET is_test = $2, updated_at = now() WHERE id = $1 RETURNING id`, [id, isTest])
    // The answer follows its game – unless that player already has an answer of that kind on the same day.
    await this.db.query(
      `UPDATE feedback f SET is_test = $2 WHERE f.session_id = $1 AND f.is_test <> $2
          AND NOT EXISTS (SELECT 1 FROM feedback g WHERE g.player_id = f.player_id AND g.is_test = $2
                             AND (g.submitted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = ${FEEDBACK_DAY})`,
      [id, isTest],
    )
    return rows.length > 0
  }

  /** Deletes all rehearsal / test data (races, runs, feedback) and players left without runs. */
  async deleteTestData(): Promise<{ runs: number; races: number }> {
    return this.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM feedback WHERE is_test = true`)
      const runs = await tx.query(`DELETE FROM runs WHERE is_test = true RETURNING id`)
      const races = await tx.query(
        `DELETE FROM races ra WHERE ra.is_test = true AND ra.status IN ('finished', 'cancelled')
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.race_id = ra.id) RETURNING id`,
      )
      await tx.query(`DELETE FROM players p WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.player_id = p.id)`)
      return { runs: runs.length, races: races.length }
    })
  }

  // ── Feedback ──────────────────────────────────────────────────────────────

  /**
   * Saves one answer. False when it clashes with a row already there: the same feedback_id (a retry)
   * or the same player on the same KL day (the unique index).
   */
  async insertFeedback(f: FeedbackRow): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO feedback (feedback_id, session_id, player_id, team_id, full_name, affiliation_type, project_name, opu,
                             q1_relevant, q2_would_explore, q2_interested_solutions, q3_understanding_rating, game_mode, submitted_at, is_test)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT DO NOTHING RETURNING feedback_id`,
      [
        f.feedback_id, f.session_id, f.player_id, f.team_id, f.full_name, f.affiliation_type, f.project_name, f.opu,
        f.q1_relevant, f.q2_would_explore, f.q2_interested_solutions, f.q3_understanding_rating, f.game_mode, iso(f.submitted_at), f.is_test,
      ],
    )
    return rows.length > 0
  }

  async feedbackExists(feedbackId: string): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM feedback WHERE feedback_id = $1', [feedbackId])).length > 0
  }

  async hasFeedback(runId: string): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM feedback WHERE session_id = $1', [runId])).length > 0
  }

  /** Stored affiliation keys of players with this name who answered on a KL day (the caller applies project merges). */
  async feedbackAffiliationsOn(nameKey: string, day: string, isTest: boolean): Promise<string[]> {
    const rows = await this.db.query<{ affil_key: string }>(
      `SELECT p.affil_key FROM feedback f JOIN players p ON p.id = f.player_id
        WHERE p.name_key = $1 AND ${FEEDBACK_DAY} = $2::date AND f.is_test = $3`,
      [nameKey, day, isTest],
    )
    return rows.map((r) => r.affil_key)
  }

  async listFeedback(opts: { from?: number; to?: number; includeTest?: boolean } = {}): Promise<FeedbackRecord[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT f.*, ra.mode AS race_mode, p.name_key, p.affil_key
         FROM feedback f JOIN runs r ON r.id = f.session_id JOIN races ra ON ra.id = r.race_id JOIN players p ON p.id = f.player_id
        WHERE ($1::timestamptz IS NULL OR f.submitted_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR f.submitted_at < $2::timestamptz)
          AND ($3::boolean OR f.is_test = false)
        ORDER BY f.submitted_at DESC`,
      [iso(opts.from), iso(opts.to), !!opts.includeTest],
    )
    return rows.map((r) => ({
      feedback_id: r.feedback_id as string,
      session_id: r.session_id as string,
      player_id: r.player_id as string,
      team_id: (r.team_id as string) ?? null,
      full_name: r.full_name as string,
      affiliation_type: r.affiliation_type as AffiliationType,
      project_name: (r.project_name as string) ?? null,
      opu: (r.opu as string) ?? null,
      q1_relevant: !!r.q1_relevant,
      q2_would_explore: !!r.q2_would_explore,
      q2_interested_solutions: Array.isArray(r.q2_interested_solutions) ? (r.q2_interested_solutions as string[]) : null,
      q3_understanding_rating: Number(r.q3_understanding_rating),
      game_mode: r.game_mode as FeedbackMode,
      submitted_at: ms(r.submitted_at)!,
      is_test: !!r.is_test,
      race_mode: r.race_mode as GameMode,
      name_key: r.name_key as string,
      affil_key: r.affil_key as string,
    }))
  }

  // ── Project names (merges & label overrides) ──────────────────────────────

  async projectAliases(): Promise<Map<string, string>> {
    const rows = await this.db.query<{ alias_key: string; target_key: string }>('SELECT alias_key, target_key FROM project_aliases')
    return new Map(rows.map((r) => [r.alias_key, r.target_key]))
  }

  async projectLabels(): Promise<Map<string, string>> {
    const rows = await this.db.query<{ project_key: string; label: string }>('SELECT project_key, label FROM project_labels')
    return new Map(rows.map((r) => [r.project_key, r.label]))
  }

  async setProjectAlias(alias: string, target: string): Promise<void> {
    await this.db.query(
      `INSERT INTO project_aliases (alias_key, target_key) VALUES ($1, $2)
       ON CONFLICT (alias_key) DO UPDATE SET target_key = EXCLUDED.target_key, created_at = now()`,
      [alias, target],
    )
    // Anything that pointed at the alias now points at the new target (keeps chains short).
    await this.db.query('UPDATE project_aliases SET target_key = $2 WHERE target_key = $1', [alias, target])
  }

  async deleteProjectAlias(alias: string): Promise<boolean> {
    return (await this.db.query('DELETE FROM project_aliases WHERE alias_key = $1 RETURNING alias_key', [alias])).length > 0
  }

  async setProjectLabel(key: string, label: string | null): Promise<void> {
    if (label === null) await this.db.query('DELETE FROM project_labels WHERE project_key = $1', [key])
    else
      await this.db.query(
        `INSERT INTO project_labels (project_key, label) VALUES ($1, $2)
         ON CONFLICT (project_key) DO UPDATE SET label = EXCLUDED.label, updated_at = now()`,
        [key, label],
      )
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  async getAdmin(): Promise<AdminUser | null> {
    const [row] = await this.db.query<Record<string, unknown>>('SELECT * FROM admin_users ORDER BY created_at LIMIT 1')
    return row
      ? {
          id: row.id as string,
          pin_hash: row.pin_hash as string,
          must_change_pin: !!row.must_change_pin,
          failed_attempts: Number(row.failed_attempts),
          locked_until: ms(row.locked_until),
        }
      : null
  }

  async createAdmin(id: string, pinHash: string): Promise<void> {
    await this.db.query('INSERT INTO admin_users (id, pin_hash, must_change_pin) VALUES ($1, $2, true)', [id, pinHash])
  }

  async setAdminFailures(id: string, attempts: number, lockedUntil: number | null): Promise<void> {
    await this.db.query('UPDATE admin_users SET failed_attempts = $2, locked_until = $3, updated_at = now() WHERE id = $1', [id, attempts, iso(lockedUntil)])
  }

  async recordAdminLogin(id: string): Promise<void> {
    await this.db.query('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [id])
  }

  async updateAdminPin(id: string, pinHash: string, mustChange: boolean): Promise<void> {
    await this.db.query('UPDATE admin_users SET pin_hash = $2, must_change_pin = $3, updated_at = now() WHERE id = $1', [id, pinHash, mustChange])
  }

  async createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void> {
    await this.db.query('DELETE FROM admin_sessions WHERE expires_at < now()')
    await this.db.query('INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, iso(expiresAt)])
  }

  async findSession(tokenHash: string): Promise<{ user_id: string; expires_at: number } | null> {
    const [row] = await this.db.query<{ user_id: string; expires_at: unknown }>('SELECT user_id, expires_at FROM admin_sessions WHERE token_hash = $1', [tokenHash])
    return row ? { user_id: row.user_id, expires_at: ms(row.expires_at)! } : null
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [tokenHash])
  }

  async deleteAllSessions(): Promise<void> {
    await this.db.query('DELETE FROM admin_sessions')
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  async audit(action: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.db.query('INSERT INTO audit_log (action, details) VALUES ($1, $2::jsonb)', [action, JSON.stringify(details)])
  }

  async recentAudit(limit = 200): Promise<{ id: number; at: string; action: string; details: Record<string, unknown> }[]> {
    const rows = await this.db.query<{ id: number; at: unknown; action: string; details: Record<string, unknown> }>(
      'SELECT id, at, action, details FROM audit_log ORDER BY at DESC, id DESC LIMIT $1',
      [limit],
    )
    return rows.map((r) => ({ id: Number(r.id), at: new Date(r.at as string).toISOString(), action: r.action, details: r.details }))
  }

  // ── Backups ───────────────────────────────────────────────────────────────

  /** Every event table as plain rows (admin PIN hashes and sessions excluded). */
  async dumpTables(): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {}
    for (const t of ['settings', 'solutions', 'players', 'races', 'runs', 'feedback', 'feedback_legacy', 'project_aliases', 'project_labels', 'audit_log']) {
      const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM ${t}`)
      out[t] = t === 'runs' || t === 'races' ? rows.map(({ token_hash: _t, host_token_hash: _h, ...rest }) => rest) : rows
    }
    return out
  }
}

/** Opens the database, applies migrations and seeds first-run content. */
export async function createStore(opts: { databaseUrl?: string; dataDir: string }): Promise<{ store: Store; migrations: string[]; seeded: string[] }> {
  const db = await openDb(opts)
  const migrations = await runMigrations(db)
  const store = new Store(db)
  const seeded = await seedContent(store)
  return { store, migrations, seeded }
}
