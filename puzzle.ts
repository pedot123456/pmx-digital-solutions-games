import { seededRandom, shuffle } from './random'
import type { AnswerToken, Puzzle, Solution, Tile } from './types'
import { cleanText } from './validation'

export interface PuzzleOptions {
  hard_mode: boolean
  hard_max_letters: number
  decoys_min: number
  decoys_max: number
  global_decoys: readonly string[]
}

export const answerWords = (name: string) => cleanText(name).split(' ').filter(Boolean)

/** Hard Mode turns short words ("PTQ", "AI", "PDSB") into letter tiles. */
export function isLetterWord(word: string, maxLetters: number): boolean {
  return word.length >= 2 && word.length <= maxLetters && /^[\p{L}\p{N}]+$/u.test(word)
}

const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ'

function uniqueWords(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const w = cleanText(raw)
    if (!w || seen.has(w.toLowerCase())) continue
    seen.add(w.toLowerCase())
    out.push(w)
  }
  return out
}

/** Decoys that could never be confused with a real answer word of this solution. */
export function usableDecoys(solution: Pick<Solution, 'name' | 'decoys'>, global: readonly string[]): { own: string[]; global: string[] } {
  const answer = new Set(answerWords(solution.name).map((w) => w.toLowerCase()))
  const own = uniqueWords(solution.decoys).filter((d) => !answer.has(d.toLowerCase()))
  const ownSet = new Set(own.map((d) => d.toLowerCase()))
  return { own, global: uniqueWords(global).filter((d) => !answer.has(d.toLowerCase()) && !ownSet.has(d.toLowerCase())) }
}

export function buildPuzzle(solution: Solution, opts: PuzzleOptions, rand: () => number): Puzzle {
  const words = answerWords(solution.name)
  const answer: AnswerToken[] = []
  const pieces: Omit<Tile, 'id'>[] = []

  words.forEach((word, wi) => {
    if (opts.hard_mode && isLetterWord(word, opts.hard_max_letters)) {
      for (const ch of word) {
        answer.push({ text: ch, word: wi })
        pieces.push({ text: ch, kind: 'letter' })
      }
      // One decoy letter per letter-word, never a letter of that word.
      const pool = LETTERS.split('').filter((c) => !word.toUpperCase().includes(c))
      pieces.push({ text: pool[Math.floor(rand() * pool.length)], kind: 'letter' })
    } else {
      answer.push({ text: word, word: wi })
      pieces.push({ text: word, kind: 'word' })
    }
  })

  const min = Math.max(0, Math.min(opts.decoys_min, opts.decoys_max))
  const max = Math.max(min, opts.decoys_max)
  const count = min + Math.floor(rand() * (max - min + 1))
  const { own, global } = usableDecoys(solution, opts.global_decoys)
  for (const d of [...shuffle(own, rand), ...shuffle(global, rand)].slice(0, count)) pieces.push({ text: d, kind: 'word' })

  // Ids are given after shuffling, so tile ids say nothing about the answer order.
  const tiles = shuffle(pieces, rand).map((p, i) => ({ ...p, id: `t${i}` }))
  return { solution_id: solution.id, name: cleanText(solution.name), clue: cleanText(solution.clue), answer, tiles }
}

/** The round: every solution once, in a random order, each with its own shuffled tiles. Same seed → same round. */
export function buildPuzzles(solutions: readonly Solution[], opts: PuzzleOptions, seed: string): Puzzle[] {
  const rand = seededRandom(seed)
  const usable = solutions.filter((s) => answerWords(s.name).length > 0)
  return shuffle(usable, rand).map((s) => buildPuzzle(s, opts, rand))
}

/** Words built so far from the placed tokens ("P","T","Q" → "PTQ"). */
export function builtWords(puzzle: Puzzle, placed: number): string[] {
  const words: string[] = []
  for (const t of puzzle.answer.slice(0, placed)) words[t.word] = (words[t.word] ?? '') + t.text
  return words.filter((w) => w !== undefined)
}
