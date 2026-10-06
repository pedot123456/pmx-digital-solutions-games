import type { GameRules, Puzzle, RunProgress } from './types'

/**
 * The race reducer. The same pure functions run on the player's device (instant feedback)
 * and on the server, which is the source of truth: it uses its own clock for `realElapsedMs`
 * (server time since GO), so the result can't be changed from the browser.
 *
 * Penalties move the clock forward: effective time = real time since GO + penalties,
 * and the run ends when the effective time reaches the limit (default 30 s).
 */

export type TapOutcome = 'correct' | 'solved' | 'finished' | 'wrong' | 'timeout' | 'ignored'
export type SkipOutcome = 'skipped' | 'timeout' | 'ignored'

export function createProgress(puzzleCount: number): RunProgress {
  return {
    queue: Array.from({ length: puzzleCount }, (_, i) => i),
    solved: [],
    progress: 0,
    used: [],
    penalty_ms: 0,
    wrong: 0,
    skips: 0,
    last_solve_ms: null,
    finish_ms: null,
    ended: null,
    stats: Array.from({ length: puzzleCount }, () => ({ wrong: 0, skips: 0, solved_ms: null })),
  }
}

export const effectiveMs = (p: RunProgress, realElapsedMs: number) => Math.max(0, realElapsedMs) + p.penalty_ms

export const remainingMs = (p: RunProgress, rules: GameRules, realElapsedMs: number) =>
  Math.max(0, rules.limit_ms - effectiveMs(p, realElapsedMs))

/** Server epoch ms at which this run runs out of time (penalties bring it forward). */
export const deadlineAt = (p: RunProgress, rules: GameRules, goAt: number) => goAt + rules.limit_ms - p.penalty_ms

export const timeUp = (p: RunProgress): RunProgress => (p.ended ? p : { ...p, ended: 'timeout' })

export function applyTap(
  p: RunProgress,
  puzzles: readonly Puzzle[],
  rules: GameRules,
  puzzleIndex: number,
  tileId: string,
  realElapsedMs: number,
): { progress: RunProgress; outcome: TapOutcome } {
  if (p.ended || realElapsedMs < 0) return { progress: p, outcome: 'ignored' }
  if (effectiveMs(p, realElapsedMs) >= rules.limit_ms) return { progress: timeUp(p), outcome: 'timeout' }
  const current = p.queue[0]
  if (current === undefined || current !== puzzleIndex) return { progress: p, outcome: 'ignored' }
  const puzzle = puzzles[current]
  const tile = puzzle?.tiles.find((t) => t.id === tileId)
  if (!puzzle || !tile || p.used.includes(tileId)) return { progress: p, outcome: 'ignored' }

  const expected = puzzle.answer[p.progress]
  // Tiles with the same text are interchangeable (e.g. a repeated letter).
  if (expected && tile.text === expected.text) {
    const used = [...p.used, tileId]
    const placed = p.progress + 1
    if (placed < puzzle.answer.length) return { progress: { ...p, used, progress: placed }, outcome: 'correct' }
    const t = effectiveMs(p, realElapsedMs)
    const queue = p.queue.slice(1)
    const solved: RunProgress = {
      ...p,
      queue,
      solved: [...p.solved, current],
      progress: 0,
      used: [],
      last_solve_ms: t,
      stats: p.stats.map((s, i) => (i === current ? { ...s, solved_ms: t } : s)),
    }
    if (!queue.length) return { progress: { ...solved, finish_ms: t, ended: 'finished' }, outcome: 'finished' }
    return { progress: solved, outcome: 'solved' }
  }

  const next: RunProgress = {
    ...p,
    penalty_ms: p.penalty_ms + rules.wrong_penalty_ms,
    wrong: p.wrong + 1,
    stats: p.stats.map((s, i) => (i === current ? { ...s, wrong: s.wrong + 1 } : s)),
  }
  if (effectiveMs(next, realElapsedMs) >= rules.limit_ms) return { progress: timeUp(next), outcome: 'timeout' }
  return { progress: next, outcome: 'wrong' }
}

/** Skip: the current solution goes to the end of the queue (its progress is cleared) for a time penalty. */
export function canSkip(p: RunProgress): boolean {
  return !p.ended && p.queue.length > 1
}

export function applySkip(
  p: RunProgress,
  rules: GameRules,
  puzzleIndex: number,
  realElapsedMs: number,
): { progress: RunProgress; outcome: SkipOutcome } {
  if (p.ended || realElapsedMs < 0) return { progress: p, outcome: 'ignored' }
  if (effectiveMs(p, realElapsedMs) >= rules.limit_ms) return { progress: timeUp(p), outcome: 'timeout' }
  if (p.queue[0] !== puzzleIndex || !canSkip(p)) return { progress: p, outcome: 'ignored' }
  const [current, ...rest] = p.queue
  const next: RunProgress = {
    ...p,
    queue: [...rest, current],
    progress: 0,
    used: [],
    penalty_ms: p.penalty_ms + rules.skip_penalty_ms,
    skips: p.skips + 1,
    stats: p.stats.map((s, i) => (i === current ? { ...s, skips: s.skips + 1 } : s)),
  }
  if (effectiveMs(next, realElapsedMs) >= rules.limit_ms) return { progress: timeUp(next), outcome: 'timeout' }
  return { progress: next, outcome: 'skipped' }
}

// ── Ranking ─────────────────────────────────────────────────────────────────

/**
 * Ranking time: the finishing time (incl. penalties) when all were solved; when the clock ran out,
 * the time of the last solve ("time used" to reach that many). Nothing solved → the full limit.
 */
export function rankingTimeMs(p: RunProgress, limitMs: number): number {
  if (p.ended === 'finished' && p.finish_ms !== null) return p.finish_ms
  return p.last_solve_ms ?? limitMs
}

export interface Rankable {
  solved: number
  time_ms: number
  /** Tie-break: who got there first (epoch ms). */
  ended_at: number
}

/** More solved first, then faster time, then earlier finish. */
export function compareRuns(a: Rankable, b: Rankable): number {
  return b.solved - a.solved || a.time_ms - b.time_ms || a.ended_at - b.ended_at
}

/** Results titles. */
export function titleFor(solved: number, total = 6): string {
  if (solved >= total) return 'NC Master'
  if (solved >= Math.max(1, total - 2)) return 'NC Explorer'
  return 'NC Rookie'
}

export const TITLE_HINTS: Record<string, string> = {
  'NC Master': 'All solutions built – the full constellation is lit.',
  'NC Explorer': 'Most of the constellation lit – so close!',
  'NC Rookie': 'A great start – play again to light up more stars.',
}
