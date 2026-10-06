import { cleanText, nameKey, type AffiliationType } from './validation'

/**
 * Where players are from: a project (free-text name) or a business OPU (from the Admin list).
 *
 * Project names are typed freely, so reporting groups them:
 * 1. case-, accent- and spacing-insensitive ("kasawari", "KASAWARI ", "Kasawari" → one group),
 *    and spaces around & / - + are ignored ("GT & C" = "GT&C");
 * 2. Admin merges: an alias key points at another group's key (e.g. "kasawari ccs" → "kasawari");
 * 3. the group label is an Admin override, or else the most-used spelling (ties: more capitals).
 *
 * Player identity ("best time per player") = full name + project group, or full name + OPU.
 */

export function projectKey(raw: string): string {
  return cleanText(raw)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s*([&/\-+])\s*/g, '$1')
    .replace(/^[\s.,;:'"()\-]+|[\s.,;:'"()\-]+$/g, '')
}

export const opuKey = (raw: string) => cleanText(raw).toLowerCase()

export interface OpuSection {
  /** Group heading ("Downstream"), or null for entries without a group ("Others"). */
  group: string | null
  items: { value: string; label: string }[]
}

/**
 * Groups the OPU list for the picker: "Downstream - MRCSB" goes under "Downstream" as "MRCSB".
 * Groups keep the order in which they first appear; entries without " - " form their own section.
 */
export function opuSections(opus: readonly string[]): OpuSection[] {
  const sections: OpuSection[] = []
  const byGroup = new Map<string | null, OpuSection>()
  for (const value of opus) {
    const at = value.indexOf(' - ')
    const group = at > 0 ? value.slice(0, at).trim() : null
    const label = at > 0 ? value.slice(at + 3).trim() : value
    let s = byGroup.get(group)
    if (!s) {
      s = { group, items: [] }
      byGroup.set(group, s)
      sections.push(s)
    }
    s.items.push({ value, label: label || value })
  }
  return sections
}

/** Stored key for a player's affiliation: "p:<project key>" or "o:<opu key>". */
export function affiliationKey(type: AffiliationType, project: string | null, opu: string | null): string {
  return type === 'project' ? `p:${projectKey(project ?? '')}` : `o:${opuKey(opu ?? '')}`
}

/** Follows merge aliases (alias key → target key) to the group key. Safe against loops. */
export function resolveAlias(key: string, aliases: ReadonlyMap<string, string>): string {
  let current = key
  const seen = new Set<string>([current])
  for (let i = 0; i < 20; i++) {
    const next = aliases.get(current)
    if (!next || seen.has(next)) break
    seen.add(next)
    current = next
  }
  return current
}

/** Identity part for a stored affiliation key, with project merges applied. */
export function resolveAffiliationKey(stored: string, aliases: ReadonlyMap<string, string>): string {
  return stored.startsWith('p:') ? `p:${resolveAlias(stored.slice(2), aliases)}` : stored
}

const capitals = (s: string) => (s.match(/\p{Lu}/gu) ?? []).length

/** Most-used spelling; ties → more capital letters ("GPE" over "Gpe"), then alphabetical. */
export function pickLabel(variants: ReadonlyMap<string, number>): string {
  let best = ''
  let bestCount = -1
  for (const [label, count] of variants) {
    if (
      count > bestCount ||
      (count === bestCount && (capitals(label) > capitals(best) || (capitals(label) === capitals(best) && label < best)))
    ) {
      best = label
      bestCount = count
    }
  }
  return best
}

export interface ProjectGroup {
  key: string
  label: string
  /** Players (distinct names) in this group. */
  players: number
  /** Original spellings with how many players typed each. */
  variants: { text: string; key: string; players: number }[]
  /** Keys merged into this group by Admin. */
  merged_keys: string[]
}

/** Builds project groups from (name, project) entries – one per spelling a player typed. */
export function groupProjects(
  entries: readonly { name: string; project: string }[],
  aliases: ReadonlyMap<string, string>,
  labels: ReadonlyMap<string, string>,
): ProjectGroup[] {
  const groups = new Map<string, { players: Set<string>; spellings: Map<string, Map<string, Set<string>>> }>()
  for (const e of entries) {
    const text = cleanText(e.project)
    const key = projectKey(text)
    if (!key) continue
    const group = resolveAlias(key, aliases)
    let g = groups.get(group)
    if (!g) groups.set(group, (g = { players: new Set(), spellings: new Map() }))
    const person = nameKey(e.name)
    g.players.add(person)
    let byKey = g.spellings.get(key)
    if (!byKey) g.spellings.set(key, (byKey = new Map()))
    let who = byKey.get(text)
    if (!who) byKey.set(text, (who = new Set()))
    who.add(person)
  }
  const out: ProjectGroup[] = []
  for (const [key, g] of groups) {
    const counts = new Map<string, number>()
    const variants: ProjectGroup['variants'] = []
    for (const [vKey, texts] of g.spellings) {
      for (const [text, who] of texts) {
        counts.set(text, (counts.get(text) ?? 0) + who.size)
        variants.push({ text, key: vKey, players: who.size })
      }
    }
    // Spellings of the group's own key win the label vote over merged-in spellings.
    const own = new Map([...counts].filter(([text]) => projectKey(text) === key))
    out.push({
      key,
      label: labels.get(key) ?? pickLabel(own.size ? own : counts),
      players: g.players.size,
      variants: variants.sort((a, b) => b.players - a.players || a.text.localeCompare(b.text)),
      merged_keys: [...g.spellings.keys()].filter((k) => k !== key).sort(),
    })
  }
  return out.sort((a, b) => b.players - a.players || a.label.localeCompare(b.label))
}

/** Maps raw project text to its group key + display label. */
export function projectLabeler(groups: readonly ProjectGroup[], aliases: ReadonlyMap<string, string>) {
  const byKey = new Map(groups.map((g) => [g.key, g.label]))
  return (raw: string): { key: string; label: string } => {
    const key = resolveAlias(projectKey(raw), aliases)
    return { key, label: byKey.get(key) ?? cleanText(raw) }
  }
}
