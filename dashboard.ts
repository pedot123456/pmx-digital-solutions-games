import type { GameMode } from './types'

/** Admin dashboard payload (GET /api/admin/dashboard). */
export interface DashboardData {
  filter: { day: string | null; mode: GameMode | 'all' }
  /** KL days that have games (newest first) for the date filter. */
  days: string[]
  kpis: {
    players: number
    games: number
    /** Games where all solutions were built. */
    completed: number
    completion_rate: number | null
    /** Average finishing time of completed games. */
    avg_finish_ms: number | null
    fastest_ms: number | null
    avg_solved: number | null
    battles: number
    /** Feedback answers (real games only). */
    feedback: number
    /** Average of feedback question 3 (1–5 stars). */
    avg_understanding: number | null
    /** Rehearsal games in the same period (not counted anywhere else). */
    rehearsal_games: number
  }
  timeline_unit: 'hour' | 'day'
  timeline: { label: string; games: number; players: number }[]
  solved_distribution: { solved: number; games: number }[]
  solutions: {
    id: string
    name: string
    /** Games in which this solution appeared. */
    rounds: number
    solved: number
    solve_rate: number | null
    wrong: number
    avg_wrong: number | null
    skips: number
  }[]
  /** Project vs Business: players and games. */
  affiliation_split: { project: { players: number; games: number }; business: { players: number; games: number } }
  /** Players per OPU (every OPU in the Admin list, in list order, plus any no longer listed). */
  opus: { name: string; players: number; games: number; best_time_ms: number | null }[]
  /** Players per project (spellings grouped, Admin merges applied). */
  projects: { key: string; label: string; players: number; games: number; best_time_ms: number | null }[]
  modes: { mode: GameMode; games: number }[]
  /** Distinct players interested in each solution (feedback question 2), highest first. */
  interest: { id: string; name: string; players: number }[]
}

export const EXPORT_TABLES = ['games', 'participants', 'feedback', 'projects', 'opus', 'solutions'] as const
export type ExportTable = (typeof EXPORT_TABLES)[number]
