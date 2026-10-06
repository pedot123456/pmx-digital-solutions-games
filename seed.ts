import { SEED_SOLUTIONS } from '@shared/seed'
import type { Store } from './store'

/** First run only: the six solutions. Settings use defaults until Admin saves them. */
export async function seedContent(store: Store): Promise<string[]> {
  const seeded: string[] = []
  const existing = new Set((await store.listSolutions()).map((s) => s.id))
  let added = 0
  for (const s of SEED_SOLUTIONS) {
    if (existing.has(s.id)) continue
    await store.upsertSolution(s)
    added++
  }
  if (added) seeded.push(`${added} solutions`)
  return seeded
}
