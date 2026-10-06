import type { AffiliationType } from './validation'

/**
 * Types shared by the kiosk, the phones, the display, the admin area and the server.
 * Times are epoch milliseconds on the SERVER clock unless a name says otherwise.
 */

export type GameMode = 'solo' | 'battle' | 'h2h'

export const MODE_LABELS: Record<GameMode, string> = {
  solo: 'Solo Rush',
  battle: 'Multiplayer Battle',
  h2h: 'Head-to-Head',
}

/** lobby → howto (10 s, everyone together) → running (3-2-1 until go_at, then racing) → finished. */
export type RaceStatus = 'lobby' | 'howto' | 'running' | 'finished' | 'cancelled'

/** waiting = in lobby / how-to / countdown; left = left the lobby or removed by the host. */
export type RunStatus = 'waiting' | 'playing' | 'finished' | 'timeout' | 'left'

// ── Content ─────────────────────────────────────────────────────────────────

export interface Solution {
  id: string
  position: number
  /** The answer players build, e.g. "Schedule Intelligent Dashboard". */
  name: string
  /** Shown during the game. */
  clue: string
  /** One-line learning recap shown on the results screen. */
  description: string
  /** Decoy words for this solution (2–3 are picked per round). */
  decoys: string[]
}

export interface Settings {
  /** Home page title, e.g. "PMX Digital Challenge". */
  event_title: string
  /** Line under the title, e.g. "Powering Project Delivery Through Digital". */
  event_subtitle: string
  timer_seconds: number
  wrong_penalty_ms: number
  skip_penalty_ms: number
  hard_mode: boolean
  /** In Hard Mode, words this short or shorter become letter tiles ("PTQ", "AI", "PDSB"). */
  hard_max_letters: number
  decoys_min: number
  decoys_max: number
  howto_seconds: number
  /** Post-game screens return to the attract screen after this much inactivity. */
  idle_seconds: number
  /** Rehearsal: games are saved as test data, excluded from boards and statistics. */
  rehearsal_mode: boolean
  sound_default: boolean
  /** Address used in the Multiplayer join QR code (phones can't open "localhost"). */
  public_base_url: string
  interest_question: string
  /** OPUs offered when a player is from Business (in display order). Editable in Admin. */
  opus: string[]
  /** Extra decoy words used when a solution has too few of its own. */
  global_decoys: string[]
  profanity: string[]
  /** "Reset daily board": today's boards only count games that ended after this moment (ISO). */
  board_reset_at: string | null
  lobby_timeout_seconds: number
}

/** Settings the kiosk / phones / display need (no blocked-word list). */
export type PublicSettings = Omit<Settings, 'profanity' | 'global_decoys'>

export interface PublicConfig {
  settings: PublicSettings
  /** Names + recap lines (the clue text is only sent inside a race). */
  solutions: Pick<Solution, 'id' | 'name' | 'description'>[]
  server_time: number
  /** KL business day "YYYY-MM-DD". */
  today: string
  version: string
}

// ── Puzzles ─────────────────────────────────────────────────────────────────

export interface Tile {
  id: string
  text: string
  kind: 'word' | 'letter'
}

/** One step of the answer; `word` groups letter tiles back into a word for display. */
export interface AnswerToken {
  text: string
  word: number
}

export interface Puzzle {
  solution_id: string
  name: string
  clue: string
  answer: AnswerToken[]
  tiles: Tile[]
}

export interface GameRules {
  limit_ms: number
  wrong_penalty_ms: number
  skip_penalty_ms: number
  hard_mode: boolean
}

export interface PuzzleStat {
  wrong: number
  skips: number
  /** Effective time (incl. penalties) when it was solved. */
  solved_ms: number | null
}

/** A player's progress through a race. Pure data: the same reducer runs on the device and the server. */
export interface RunProgress {
  /** Puzzle indexes still to solve; [0] is the current one (Skip moves it to the end). */
  queue: number[]
  /** Puzzle indexes in the order they were solved. */
  solved: number[]
  /** Answer tokens already placed for the current puzzle. */
  progress: number
  /** Tile ids used for the current puzzle. */
  used: string[]
  penalty_ms: number
  wrong: number
  skips: number
  /** Effective time (real elapsed + penalties) of the latest solve. */
  last_solve_ms: number | null
  /** Effective finishing time when all puzzles were solved. */
  finish_ms: number | null
  ended: 'finished' | 'timeout' | null
  stats: PuzzleStat[]
}

// ── Races (what clients receive) ────────────────────────────────────────────

export interface RunPublic {
  id: string
  lane: number
  /** Full name as typed. */
  name: string
  affiliation_type: AffiliationType
  /** The project name or the OPU (the "Project / OPU" column). */
  affiliation: string
  status: RunStatus
  connected: boolean
  progress: RunProgress
  /** Ranking time once ended: finishing time, or time of the last solve when the clock ran out. */
  time_ms: number | null
  /** Place within this race once it has finished. */
  place: number | null
  is_winner: boolean
}

export interface RaceState {
  id: string
  mode: GameMode
  status: RaceStatus
  room_code: string | null
  rules: GameRules
  /** Sent once the race is running (everyone gets the same order and tile shuffle). */
  puzzles: Puzzle[]
  /** Tokens per puzzle (for progress bars before/without the puzzles). */
  answer_lengths: number[]
  howto_ends_at: number | null
  go_at: number | null
  ended_at: number | null
  is_test: boolean
  max_players: number
  runs: RunPublic[]
}

// ── Boards ──────────────────────────────────────────────────────────────────

export interface BoardRow {
  rank: number
  player_key: string
  /** Full name as typed. */
  name: string
  affiliation_type: AffiliationType
  /** The project name or the OPU (the "Project / OPU" column). */
  affiliation: string
  solved: number
  time_ms: number
  mode: GameMode
  run_id: string
  ended_at: string
}

export interface WinsRow {
  rank: number
  player_key: string
  /** Full name as typed. */
  name: string
  affiliation_type: AffiliationType
  /** The project name or the OPU (the "Project / OPU" column). */
  affiliation: string
  wins: number
  battles: number
  best_time_ms: number | null
}

export interface Boards {
  day: string
  today: BoardRow[]
  all_time: BoardRow[]
  wins_today: WinsRow[]
  wins_all_time: WinsRow[]
  stats: {
    players_today: number
    players_total: number
    games_today: number
    fastest_today: BoardRow | null
  }
}

export interface RunResult {
  run_id: string
  race_id: string
  mode: GameMode
  /** Full name as typed. */
  name: string
  affiliation_type: AffiliationType
  /** The project name or the OPU (the "Project / OPU" column). */
  affiliation: string
  solved: number
  total: number
  time_ms: number
  finished: boolean
  penalty_ms: number
  wrong: number
  skips: number
  title: string
  /** Place on today's Fastest Times board (best run per player); null for rehearsal games. */
  rank_today: number | null
  players_today: number
  /** Place within a Battle / Head-to-Head race. */
  place: number | null
  is_winner: boolean
  is_test: boolean
  /** Solutions in this round with whether this player solved them (learning recap). */
  recap: { solution_id: string; name: string; description: string; solved: boolean }[]
  feedback_given: boolean
}
